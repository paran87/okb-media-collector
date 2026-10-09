import type { ViberConfig } from "../config/environment";
import type {
  Capability,
  MediaDownload,
  MediaSourceAdapter,
  PlatformProbe,
  WebhookRequest,
  WebhookResult,
} from "../adapters/MediaSourceAdapter";
import type { NormalizedMedia } from "../model/message";
import { header, verifyHmacSignature } from "../security/authentication";
import type { FetchPolicy } from "../security/safeFetch";
import { ViberMediaHandler } from "./ViberMediaHandler";
import { normalizeViberCallback } from "./ViberNormalizer";
import type { ViberAccountInfo, ViberCallback } from "./types";

/** Reported for Viber group media: the official Bot API has no access to group chats. */
export const VIBER_MEDIA_CAPTURE_UNSUPPORTED = "VIBER_MEDIA_CAPTURE_UNSUPPORTED";

/**
 * Viber — OFFICIAL adapter (REST Bot API).
 *
 * The Bot API delivers only 1:1 conversations between a user and the bot (no group or Community callbacks), so:
 *   - existing OKB Viber groups: VIBER_MEDIA_CAPTURE_UNSUPPORTED (nothing is implemented to work around it);
 *   - reporters can send text, photos and videos directly to the OKB bot; allowlisted sender ids only;
 *   - files (PDF/DOC…): Viber's own documentation says file messages are not supported from user to bot, while
 *     its callback table still lists `file`; a received `file` is processed, but it is not claimed as supported.
 * Since 5 Feb 2024 new Viber bots are available only on commercial terms (Rakuten Viber or its partners).
 *
 * Webhook security: every callback must carry X-Viber-Content-Signature = HMAC-SHA256(auth token, raw body).
 */
export class ViberAdapter implements MediaSourceAdapter {
  readonly source = "viber" as const;
  readonly mode = "official" as const;
  readonly webhookPath = "/webhooks/viber";
  readonly groupCaptureSupported = false;
  private readonly media: ViberMediaHandler;

  constructor(
    private readonly cfg: ViberConfig,
    policy: FetchPolicy,
  ) {
    this.media = new ViberMediaHandler(policy);
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
    if (req.method !== "POST") return { ...none, signature: "not_applicable", response: { status: 405, body: "method not allowed" } };
    if (!verifyHmacSignature(this.cfg.authToken, req.rawBody, header(req.headers, "x-viber-content-signature"))) {
      return { ...none, signature: "invalid", response: { status: 401, body: "invalid signature" } };
    }
    const raw = req.rawBody.toString("utf8");
    let cb: ViberCallback;
    try {
      cb = JSON.parse(raw) as ViberCallback;
    } catch {
      return { ...none, signature: "valid", response: { status: 400, body: "invalid JSON" } };
    }
    const { message, skipped } = normalizeViberCallback(cb, raw);
    return {
      messages: message ? [message] : [],
      skipped: skipped ? 1 : 0,
      signature: "valid",
      // Viber accepts the webhook only when it answers 200.
      response: { status: 200, body: "ok" },
    };
  }

  fetchMedia(media: NormalizedMedia, signal: AbortSignal): Promise<MediaDownload> {
    return this.media.open(media, signal);
  }

  async probe(): Promise<PlatformProbe> {
    const checkedAt = new Date().toISOString();
    if (!this.cfg.enabled) return { status: "disabled", detail: null, checkedAt };
    try {
      const res = await fetch(`${this.cfg.apiBaseUrl}/get_account_info`, {
        method: "POST",
        headers: { "X-Viber-Auth-Token": this.cfg.authToken, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      });
      const info = (await res.json().catch(() => ({}))) as ViberAccountInfo;
      if (res.ok && info.status === 0) {
        return { status: "connected", detail: info.webhook ? "bot token verified; webhook is set" : "bot token verified; NO webhook set (run set-webhook)", checkedAt };
      }
      if (info.status === 2) return { status: "auth_error", detail: "invalid Viber auth token", checkedAt };
      return { status: "error", detail: `Viber answered status ${info.status ?? res.status}`, checkedAt };
    } catch (err) {
      return { status: "unreachable", detail: (err as Error).name === "TimeoutError" ? "timeout" : "network error", checkedAt };
    }
  }

  capabilities(): Capability[] {
    return VIBER_OFFICIAL_CAPABILITIES;
  }
}

export const VIBER_OFFICIAL_CAPABILITIES: Capability[] = [
  { feature: "existing Viber groups / Communities", status: "unsupported", note: `${VIBER_MEDIA_CAPTURE_UNSUPPORTED}: the Bot API receives 1:1 conversations only` },
  { feature: "direct (1:1) messages to the OKB bot", status: "supported", note: "allowlisted sender ids only; bots require commercial terms since 5 Feb 2024" },
  { feature: "text", status: "supported", note: "message.text" },
  { feature: "photo", status: "supported", note: "picture: URL valid 1 hour" },
  { feature: "video", status: "supported", note: "video: URL valid 1 hour" },
  { feature: "documents (PDF/DOC/DOCX/XLS/XLSX)", status: "not_documented", note: "Viber docs: file type is not supported user->bot (callback table still lists file_name/file_size)" },
  { feature: "sender id / name", status: "supported", note: "sender.id, sender.name" },
  { feature: "group id / group name", status: "unsupported", note: "no group context in bot callbacks" },
  { feature: "message id / timestamp", status: "supported", note: "message_token (64-bit), timestamp (ms)" },
  { feature: "original media", status: "limited", note: "file as served by Viber's media URL (Viber may have compressed photos/videos)" },
];
