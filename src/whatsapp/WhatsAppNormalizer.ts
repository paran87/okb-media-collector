import { boundedText, MAX_TEXT_CHARS, type MediaKind, type NormalizedMedia, type NormalizedMessage } from "../model/message";
import type { WaChangeValue, WaMediaObject, WaMessage, WaWebhookBody } from "./types";

/**
 * WhatsApp Cloud API webhook -> NormalizedMessage.
 *
 * - Only `messages` changes for the configured business phone number id are read (a webhook app can serve
 *   several numbers; others are ignored).
 * - Group messages carry `group_id`; messages without it are direct (1:1) messages to the business number.
 * - Contacts cards, reactions, system and interactive messages are not collected (data minimization).
 * - `unsupported` messages are kept as "media_unavailable": WhatsApp told us something was sent but did not
 *   deliver it to the API — never presented as captured.
 * - Group display names are not in the webhook; they come from the allowlist label.
 */

const MEDIA_TYPES: Record<string, MediaKind> = { image: "image", video: "video", document: "document", audio: "audio", sticker: "sticker" };
const IGNORED_TYPES = new Set(["contacts", "reaction", "system", "interactive", "button", "order", "request_welcome", "ephemeral"]);

const str = (v: unknown, max = 4096): string | null => boundedText(v, max);

function isoFromUnixSeconds(ts: unknown): string | null {
  const n = typeof ts === "string" && /^\d{9,11}$/.test(ts) ? Number(ts) : typeof ts === "number" ? ts : NaN;
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : null;
}

function mediaFrom(kind: MediaKind, o: WaMediaObject | undefined): NormalizedMedia {
  const id = str(o?.id, 256);
  return {
    available: Boolean(id),
    kind,
    platformMediaId: id,
    filename: str(o?.filename, 512),
    mimeType: str(o?.mime_type, 200),
    size: null, // not in the webhook; the media URL lookup returns file_size
    downloadUrl: null,
    unavailableReason: id ? null : "Webhook did not include a media id",
  };
}

function locationText(m: WaMessage): string | null {
  const l = m.location;
  if (!l || typeof l.latitude !== "number" || typeof l.longitude !== "number") return null;
  const label = [str(l.name, 200), str(l.address, 300)].filter(Boolean).join(", ");
  return `[Location] ${label ? `${label} ` : ""}(${l.latitude}, ${l.longitude})`;
}

export interface WaNormalizeResult {
  messages: NormalizedMessage[];
  skipped: number;
}

export function normalizeWhatsAppWebhook(body: WaWebhookBody, phoneNumberId: string): WaNormalizeResult {
  const out: NormalizedMessage[] = [];
  let skipped = 0;
  if (body?.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return { messages: out, skipped: 1 };
  for (const entry of body.entry) {
    for (const change of entry?.changes ?? []) {
      const value: WaChangeValue | undefined = change?.value;
      if (change?.field !== "messages" || !value || value.metadata?.phone_number_id !== phoneNumberId) {
        skipped++;
        continue;
      }
      if (!Array.isArray(value.messages)) {
        skipped++; // delivery/read statuses of outbound messages
        continue;
      }
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) if (c?.wa_id && c.profile?.name) names.set(c.wa_id, c.profile.name.slice(0, 200));
      for (const m of value.messages) {
        const n = normalizeOne(m, names);
        if (n) out.push(n);
        else skipped++;
      }
    }
  }
  return { messages: out, skipped };
}

function normalizeOne(m: WaMessage, names: Map<string, string>): NormalizedMessage | null {
  const id = str(m?.id, 256);
  const receivedAt = isoFromUnixSeconds(m?.timestamp);
  const type = str(m?.type, 50) ?? "unknown";
  if (!id || !receivedAt || IGNORED_TYPES.has(type)) return null;
  const from = str(m.from, 64);
  const groupId = str(m.group_id, 200);

  let text: string | null = null;
  let media: NormalizedMedia | null = null;
  if (type === "text") text = str(m.text?.body, MAX_TEXT_CHARS);
  else if (MEDIA_TYPES[type]) {
    const obj = (m as Record<string, unknown>)[type] as WaMediaObject | undefined;
    media = mediaFrom(MEDIA_TYPES[type]!, obj);
    text = str(obj?.caption, MAX_TEXT_CHARS);
  } else if (type === "location") text = locationText(m);
  else if (type === "unsupported") {
    const e = m.errors?.[0];
    media = {
      available: false, kind: "other", platformMediaId: null, filename: null, mimeType: null, size: null, downloadUrl: null,
      unavailableReason: `WhatsApp reported an unsupported message type${e?.code ? ` (code ${e.code})` : ""}; the content was not delivered to the API`,
    };
  } else return null;

  if (text === null && media === null) return null;
  return {
    source: "whatsapp",
    mode: "official",
    platformMessageId: id,
    conversationType: groupId ? "group" : "direct",
    groupId,
    groupName: null,
    senderId: from,
    senderName: from ? names.get(from) ?? null : null,
    messageText: text,
    receivedAt,
    messageType: type,
    media,
  };
}
