import type { MediaDownload } from "../adapters/MediaSourceAdapter";
import type { NormalizedMedia } from "../model/message";
import { classifyNetworkError, isTransientStatus, PermanentError, TransientError } from "../queue/retry";
import { safeFetch, type FetchPolicy } from "../security/safeFetch";

/**
 * Viber media: the callback carries a URL with a 1-hour TTL (no auth header). The URL must be on an allowlisted
 * Viber host (VIBER_MEDIA_HOSTS). After the TTL the platform no longer provides the file: the media is recorded
 * as unavailable instead of being retried forever.
 */
export class ViberMediaHandler {
  constructor(private readonly policy: FetchPolicy) {}

  async open(media: NormalizedMedia, signal: AbortSignal): Promise<MediaDownload> {
    if (!media.downloadUrl) throw new PermanentError("no media URL", "no_media_url");
    let response: Response;
    try {
      response = await safeFetch(media.downloadUrl, { signal }, this.policy);
    } catch (err) {
      if ((err as Error).name === "BlockedUrlError") throw new PermanentError((err as Error).message, "media_url_blocked");
      throw classifyNetworkError(err, "Viber media download");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const msg = `Viber media download failed (HTTP ${response.status})`;
      if (response.status === 403 || response.status === 404 || response.status === 410) {
        throw new PermanentError(msg, "media_url_expired", response.status);
      }
      throw isTransientStatus(response.status) ? new TransientError(msg, `viber_http_${response.status}`, response.status) : new PermanentError(msg, `viber_http_${response.status}`, response.status);
    }
    const len = response.headers.get("content-length");
    return {
      response,
      declaredSize: media.size ?? (len !== null && Number.isFinite(Number(len)) ? Number(len) : null),
      declaredMime: response.headers.get("content-type"),
      declaredSha256: null,
    };
  }
}
