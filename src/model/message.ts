/**
 * Platform-independent message model. Every adapter normalizes what its platform delivers into a
 * NormalizedMessage; nothing after the adapter knows which platform a message came from except through
 * `source`. A field the platform does not provide is null — never guessed or invented.
 */

export type Source = "whatsapp" | "viber";

/**
 * Longest message text kept (WhatsApp texts are ≤ 4096 characters, Viber ≤ 7000). Keeps every registration
 * request well under the backend's 64 KB JSON body limit even with multi-byte characters.
 */
export const MAX_TEXT_CHARS = 8000;

/** Bounded copy of untrusted platform text: trims to `max` UTF-16 units without splitting a surrogate pair. */
export function boundedText(v: unknown, max: number): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  if (v.length <= max) return v;
  const cut = v.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
export type AdapterMode = "official" | "experimental";
export type ConversationType = "group" | "direct";

/** Media kinds the collector stores. Audio and stickers are recognised but not collected (out of scope). */
export type MediaKind = "image" | "video" | "document" | "audio" | "sticker" | "other";

export interface NormalizedMedia {
  /** True only when the platform API exposes the file itself for download. */
  available: boolean;
  kind: MediaKind;
  /** Platform media id (WhatsApp media id); null when the platform gives a URL instead. */
  platformMediaId: string | null;
  /** Filename as sent by the platform (untrusted; sanitized before any use). */
  filename: string | null;
  /** MIME type declared by the platform (untrusted; checked against the file signature). */
  mimeType: string | null;
  /** Size declared by the platform in bytes (untrusted; enforced while downloading). */
  size: number | null;
  /** Direct download URL when the platform provides one (Viber, 1-hour TTL). Never logged. */
  downloadUrl: string | null;
  /** Why the file is not available, when `available` is false. */
  unavailableReason: string | null;
}

export interface NormalizedMessage {
  source: Source;
  mode: AdapterMode;
  platformMessageId: string;
  conversationType: ConversationType;
  /** Stable platform group id (WhatsApp group_id). Null for direct conversations. */
  groupId: string | null;
  /** Display name: from the allowlist label, or null. */
  groupName: string | null;
  senderId: string | null;
  senderName: string | null;
  messageText: string | null;
  /** Platform timestamp of the message (ISO 8601). */
  receivedAt: string;
  /** Platform message type, e.g. "text", "image", "document", "unsupported". */
  messageType: string;
  media: NormalizedMedia | null;
}

/** Stable idempotency key shared with the backend: source + platform message id + media id. */
export function idempotencyKey(m: Pick<NormalizedMessage, "source" | "platformMessageId" | "media">): string {
  return `${m.source}:${m.platformMessageId}:${m.media?.platformMediaId || "-"}`;
}

/** Outcome of the media of one message, as registered with the backend. */
export type MediaOutcomeStatus = "stored" | "duplicate" | "media_unavailable" | "rejected" | "not_collected";

export interface MediaOutcome {
  status: MediaOutcomeStatus;
  kind: MediaKind;
  reason: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
  sha256: string | null;
  objectKey: string | null;
}
