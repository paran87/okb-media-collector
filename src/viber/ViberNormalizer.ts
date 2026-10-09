import { boundedText, MAX_TEXT_CHARS, type NormalizedMedia, type NormalizedMessage } from "../model/message";
import type { ViberCallback } from "./types";

/**
 * Viber Bot API callback -> NormalizedMessage.
 *
 * Only `message` events are collected; webhook/subscribed/unsubscribed/conversation_started/delivered/seen/
 * failed are acknowledged and skipped. Every Viber bot conversation is 1:1 (`direct`), so authorization is by
 * sender id. Media arrives as a URL valid for 1 hour.
 *
 * `message_token` is a 64-bit integer; JSON.parse would round it, so it is taken from the raw body text.
 */

const str = (v: unknown, max = 4096): string | null => boundedText(v, max);

export function rawMessageToken(raw: string): string | null {
  const m = /"message_token"\s*:\s*"?(\d{1,25})"?/.exec(raw);
  return m ? m[1]! : null;
}

function media(kind: NormalizedMedia["kind"], cb: ViberCallback): NormalizedMedia {
  const url = str(cb.message?.media, 4096);
  const size = typeof cb.message?.file_size === "number" && cb.message.file_size >= 0 ? cb.message.file_size : null;
  return {
    available: Boolean(url),
    kind,
    platformMediaId: null,
    filename: str(cb.message?.file_name, 256),
    mimeType: null, // Viber does not declare a MIME type; the file signature decides
    size,
    downloadUrl: url,
    unavailableReason: url ? null : "Viber callback did not include a media URL",
  };
}

export function normalizeViberCallback(cb: ViberCallback, raw: string): { message: NormalizedMessage | null; skipped: boolean } {
  if (cb?.event !== "message") return { message: null, skipped: true };
  const token = rawMessageToken(raw);
  const ts = typeof cb.timestamp === "number" && Number.isFinite(cb.timestamp) ? new Date(cb.timestamp).toISOString() : null;
  const senderId = str(cb.sender?.id, 200);
  if (!token || !ts || !senderId) return { message: null, skipped: true };
  const type = str(cb.message?.type, 30) ?? "unknown";

  let text: string | null = str(cb.message?.text, MAX_TEXT_CHARS);
  let m: NormalizedMedia | null = null;
  switch (type) {
    case "text":
    case "url":
      break;
    case "picture":
      m = media("image", cb);
      break;
    case "video":
      m = media("video", cb);
      break;
    case "file":
      m = media("document", cb);
      break;
    case "sticker":
      m = { ...media("sticker", cb), available: false, downloadUrl: null, unavailableReason: null };
      break;
    case "location": {
      const l = cb.message?.location;
      text = l && typeof l.lat === "number" && typeof l.lon === "number" ? `[Location] (${l.lat}, ${l.lon})` : null;
      break;
    }
    default:
      return { message: null, skipped: true }; // contact cards and anything else: not collected
  }
  if (text === null && m === null) return { message: null, skipped: true };
  return {
    skipped: false,
    message: {
      source: "viber",
      mode: "official",
      platformMessageId: token,
      conversationType: "direct",
      groupId: null,
      groupName: null,
      senderId,
      senderName: str(cb.sender?.name, 200),
      messageText: text,
      receivedAt: ts,
      messageType: type,
      media: m,
    },
  };
}
