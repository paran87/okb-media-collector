import type { Config } from "../config/environment";
import type { MediaIngestionService } from "../okb/MediaIngestionService";
import type { PersistentQueue } from "../queue/PersistentQueue";
import type { Source } from "../model/message";
import { VIBER_MEDIA_CAPTURE_UNSUPPORTED } from "../viber/ViberAdapter";

/**
 * GET /health. Statuses are only "connected" after a real successful call:
 *   platform  -> a credential check against the platform API (probe), refreshed every 10 minutes
 *   okbBackend -> the last authenticated backend call (heartbeat / ingestion) succeeded
 *   r2        -> the last upload to R2 succeeded ("configured" = backend has R2 but nothing uploaded yet)
 * No ids, names, message content or secrets are included (the same snapshot is sent to the backend).
 */

export const VERSION = "1.0.0";

export function healthSnapshot(config: Config, service: MediaIngestionService, queue: PersistentQueue): Record<string, unknown> {
  const platform = (source: Source) => {
    const adapter = service.adapterFor(source);
    const enabled = Boolean(adapter?.enabled);
    const state = service.platformState.get(source);
    const probe = state?.probe ?? null;
    const counts = service.allowlistCounts(source);
    const status = !enabled ? "disabled" : service.paused[source] ? "paused" : probe?.status ?? "unknown";
    return {
      enabled,
      mode: adapter?.mode ?? "official",
      status,
      detail: probe?.detail ?? null,
      checkedAt: probe?.checkedAt ?? null,
      paused: service.paused[source],
      lastWebhookAt: state?.lastWebhookAt ?? null,
      allowlist: counts,
      groupCapture:
        source === "viber"
          ? { status: "unsupported", code: VIBER_MEDIA_CAPTURE_UNSUPPORTED }
          : { status: enabled && counts.groups > 0 ? "limited" : "not_configured", code: "OFFICIAL_WHATSAPP_MEDIA_CAPTURE_LIMITATION" },
    };
  };
  const r2Status =
    service.r2State.lastUploadOk === true
      ? "connected"
      : service.r2State.lastUploadOk === false
        ? "error"
        : service.backendState.media === "r2"
          ? "configured"
          : service.backendState.media
            ? "not_configured"
            : "unknown";
  const q = queue.stats();
  const whatsapp = platform("whatsapp");
  const viber = platform("viber");
  const degraded =
    service.backendState.status !== "connected" ||
    r2Status === "error" ||
    [whatsapp, viber].some((p) => p.enabled && !["connected", "paused", "unknown"].includes(p.status as string)) ||
    q.failed > 0;
  return {
    status: degraded ? "degraded" : "ok",
    service: "okb-media-collector",
    version: VERSION,
    collectorId: config.collectorId,
    uptime: Math.round((Date.now() - service.startedAt.getTime()) / 1000),
    time: new Date().toISOString(),
    whatsapp,
    viber,
    r2: { status: r2Status, lastUploadAt: service.r2State.lastUploadAt, via: "okb-backend presigned uploads" },
    okbBackend: { status: service.backendState.status, lastSuccessAt: service.backendState.lastSuccessAt },
    queue: { pending: q.pending, failed: q.failed, diskBytes: q.diskBytes },
    limits: {
      maxImageMb: config.limits.maxImageBytes / 1048576,
      maxDocumentMb: config.limits.maxDocumentBytes / 1048576,
      maxVideoMb: config.limits.maxVideoBytes / 1048576,
    },
  };
}
