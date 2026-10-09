import type { WhatsAppConfig } from "../config/environment";
import type {
  Capability,
  MediaDownload,
  MediaSourceAdapter,
  PlatformProbe,
  WebhookRequest,
  WebhookResult,
} from "../adapters/MediaSourceAdapter";
import type { NormalizedMedia } from "../model/message";
import { header, safeEqual, verifyHmacSignature } from "../security/authentication";
import type { FetchPolicy } from "../security/safeFetch";
import { WhatsAppMediaHandler } from "./WhatsAppMediaHandler";
import { normalizeWhatsAppWebhook } from "./WhatsAppNormalizer";
import type { WaWebhookBody } from "./types";

/**
 * WhatsApp — OFFICIAL adapter (WhatsApp Business Platform, Cloud API webhooks + Media API).
 *
 * What it can collect (see docs/CAPABILITIES.md):
 *   - messages sent 1:1 to the OKB business number by allowlisted senders (WHATSAPP_ALLOWED_SENDER_IDS);
 *   - messages in groups created through the Cloud API Groups API by an Official Business Account
 *     (WHATSAPP_ALLOWED_GROUP_IDS; max 8 participants, invite-link only).
 * OFFICIAL_WHATSAPP_MEDIA_CAPTURE_LIMITATION: the Cloud API cannot join or read an existing ordinary WhatsApp
 * group; those groups stay with the Android bridge.
 *
 * Webhook security: GET verification compares hub.verify_token in constant time; every POST must carry a valid
 * X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret) or it is rejected unread.
 */
export class WhatsAppAdapter implements MediaSourceAdapter {
  readonly source = "whatsapp" as const;
  readonly mode = "official" as const;
  readonly webhookPath = "/webhooks/whatsapp";
  readonly groupCaptureSupported = true;
  private readonly media: WhatsAppMediaHandler;

  constructor(
    private readonly cfg: WhatsAppConfig,
    policy: FetchPolicy,
  ) {
    this.media = new WhatsAppMediaHandler(cfg, policy);
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }
  get allowedGroups() {
    return this.cfg.allowedGroups;
  }
  get allowedSenders() {
    return this.cfg.allowedSenders;
  }

  async handleWebhook(req: WebhookRequest): Promise<WebhookResult> {
    const none = { messages: [], skipped: 0 };
    if (req.method === "GET") {
      const mode = req.query.get("hub.mode");
      const token = req.query.get("hub.verify_token") ?? "";
      const challenge = req.query.get("hub.challenge") ?? "";
      if (mode === "subscribe" && safeEqual(token, this.cfg.verifyToken) && /^[A-Za-z0-9_.-]{1,200}$/.test(challenge)) {
        return { ...none, signature: "valid", response: { status: 200, body: challenge, contentType: "text/plain" } };
      }
      return { ...none, signature: "invalid", response: { status: 403, body: "forbidden", contentType: "text/plain" } };
    }
    if (req.method !== "POST") return { ...none, signature: "not_applicable", response: { status: 405, body: "method not allowed" } };
    if (!verifyHmacSignature(this.cfg.appSecret, req.rawBody, header(req.headers, "x-hub-signature-256"), "sha256=")) {
      return { ...none, signature: "invalid", response: { status: 401, body: "invalid signature" } };
    }
    let body: WaWebhookBody;
    try {
      body = JSON.parse(req.rawBody.toString("utf8")) as WaWebhookBody;
    } catch {
      return { ...none, signature: "valid", response: { status: 400, body: "invalid JSON" } };
    }
    const { messages, skipped } = normalizeWhatsAppWebhook(body, this.cfg.phoneNumberId);
    return { messages, skipped, signature: "valid", response: { status: 200, body: "ok" } };
  }

  fetchMedia(media: NormalizedMedia, signal: AbortSignal): Promise<MediaDownload> {
    return this.media.open(media, signal);
  }

  async probe(): Promise<PlatformProbe> {
    const checkedAt = new Date().toISOString();
    if (!this.cfg.enabled) return { status: "disabled", detail: null, checkedAt };
    try {
      const res = await fetch(
        `${this.cfg.graphBaseUrl}/${this.cfg.graphApiVersion}/${encodeURIComponent(this.cfg.phoneNumberId)}?fields=id`,
        { headers: { Authorization: `Bearer ${this.cfg.accessToken}` }, signal: AbortSignal.timeout(15_000) },
      );
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return { status: "connected", detail: "Cloud API credentials verified for the configured phone number id", checkedAt };
      if (res.status === 401 || res.status === 403) return { status: "auth_error", detail: `Graph API answered HTTP ${res.status} (access token invalid or expired)`, checkedAt };
      return { status: "error", detail: `Graph API answered HTTP ${res.status}`, checkedAt };
    } catch (err) {
      return { status: "unreachable", detail: (err as Error).name === "TimeoutError" ? "timeout" : "network error", checkedAt };
    }
  }

  capabilities(): Capability[] {
    return WHATSAPP_OFFICIAL_CAPABILITIES;
  }
}

export const WHATSAPP_OFFICIAL_CAPABILITIES: Capability[] = [
  { feature: "existing ordinary WhatsApp groups", status: "unsupported", note: "OFFICIAL_WHATSAPP_MEDIA_CAPTURE_LIMITATION: the Cloud API cannot join or read groups it did not create" },
  { feature: "groups created via the Groups API", status: "limited", note: "Official Business Account only; max 8 participants; invite link only; webhook delivers group_id" },
  { feature: "direct (1:1) messages to the business number", status: "supported", note: "allowlisted senders only" },
  { feature: "text", status: "supported", note: "text.body" },
  { feature: "photo", status: "supported", note: "image (JPEG/PNG, platform limit 5 MB) via Media API" },
  { feature: "video", status: "supported", note: "MP4/3GPP, platform limit 16 MB" },
  { feature: "documents (PDF/DOC/DOCX/XLS/XLSX/PPT/PPTX/TXT)", status: "supported", note: "document messages, platform limit 100 MB; original filename provided" },
  { feature: "inbound group media payload", status: "not_documented", note: "Meta's group webhook sample shows text only; media in groups must be confirmed with a real test (TEST 2–4)" },
  { feature: "sender id / name", status: "supported", note: "from (phone number) + contacts[].profile.name" },
  { feature: "group id / group name", status: "limited", note: "group_id in webhook; name only from the allowlist label" },
  { feature: "message id / timestamp", status: "supported", note: "messages[].id, messages[].timestamp" },
  { feature: "original media", status: "supported", note: "as sent by WhatsApp (WhatsApp may compress photos/videos sent as media; documents are unchanged)" },
  { feature: "history before the webhook was set up", status: "unsupported", note: "webhooks only; no history endpoint" },
];
