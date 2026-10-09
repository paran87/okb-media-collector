import type { WhatsAppConfig } from "../config/environment";
import type { MediaDownload } from "../adapters/MediaSourceAdapter";
import type { NormalizedMedia } from "../model/message";
import { classifyNetworkError, isTransientStatus, PermanentError, TransientError } from "../queue/retry";
import { safeFetch, type FetchPolicy } from "../security/safeFetch";
import type { WaMediaUrlResponse } from "./types";

/**
 * Media download through the official Cloud API Media endpoint:
 *   1. GET /{version}/{media-id}?phone_number_id=…  (Bearer access token) -> { url, mime_type, sha256, file_size }
 *   2. GET {url}  (Bearer access token)             -> the file
 * Media URLs expire after 5 minutes, so step 1 is repeated on every attempt. Media ids from webhooks are
 * downloadable for a limited time (Meta documents 7 days); after that the media is recorded as unavailable.
 */
export class WhatsAppMediaHandler {
  constructor(
    private readonly cfg: WhatsAppConfig,
    private readonly policy: FetchPolicy,
  ) {}

  async open(media: NormalizedMedia, signal: AbortSignal): Promise<MediaDownload> {
    if (!media.platformMediaId) throw new PermanentError("no media id", "no_media_id");
    const lookup = `${this.cfg.graphBaseUrl}/${this.cfg.graphApiVersion}/${encodeURIComponent(media.platformMediaId)}?phone_number_id=${encodeURIComponent(this.cfg.phoneNumberId)}`;
    let meta: WaMediaUrlResponse;
    try {
      const res = await fetch(lookup, { headers: { Authorization: `Bearer ${this.cfg.accessToken}` }, signal });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        const msg = `WhatsApp media lookup failed (HTTP ${res.status})`;
        // 400/404: the id is unknown or expired — the platform no longer provides this file.
        if (res.status === 400 || res.status === 404 || res.status === 410) throw new PermanentError(msg, "media_expired_or_unknown", res.status);
        throw isTransientStatus(res.status) ? new TransientError(msg, res.status === 401 ? "whatsapp_auth" : `whatsapp_http_${res.status}`, res.status) : new PermanentError(msg, `whatsapp_http_${res.status}`, res.status);
      }
      meta = (await res.json()) as WaMediaUrlResponse;
    } catch (err) {
      if (err instanceof TransientError || err instanceof PermanentError) throw err;
      throw classifyNetworkError(err, "WhatsApp media lookup");
    }
    if (typeof meta.url !== "string") throw new TransientError("WhatsApp media lookup returned no URL", "no_media_url");
    const declaredSize = meta.file_size !== undefined && Number.isFinite(Number(meta.file_size)) ? Number(meta.file_size) : null;

    let response: Response;
    try {
      response = await safeFetch(meta.url, { headers: { Authorization: `Bearer ${this.cfg.accessToken}` }, signal }, this.policy);
    } catch (err) {
      if ((err as Error).name === "BlockedUrlError") throw new PermanentError((err as Error).message, "media_url_blocked");
      throw classifyNetworkError(err, "WhatsApp media download");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // 404 on the download URL: the URL expired; the next attempt looks it up again.
      const msg = `WhatsApp media download failed (HTTP ${response.status})`;
      throw isTransientStatus(response.status) || response.status === 404
        ? new TransientError(msg, `whatsapp_download_${response.status}`, response.status)
        : new PermanentError(msg, `whatsapp_download_${response.status}`, response.status);
    }
    return {
      response,
      declaredSize,
      declaredMime: typeof meta.mime_type === "string" ? meta.mime_type : media.mimeType,
      declaredSha256: typeof meta.sha256 === "string" ? meta.sha256 : null,
    };
  }
}
