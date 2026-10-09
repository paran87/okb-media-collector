import { join } from "node:path";
import type { Server } from "node:http";
import type { MediaSourceAdapter } from "./adapters/MediaSourceAdapter";
import type { Config } from "./config/environment";
import { createAudit, type Audit } from "./logging/audit";
import { createLogger, type Logger } from "./logging/logger";
import { Metrics } from "./logging/metrics";
import { MediaIngestionService } from "./okb/MediaIngestionService";
import { OKBApiClient } from "./okb/OKBApiClient";
import { PersistentQueue } from "./queue/PersistentQueue";
import type { FetchPolicy } from "./security/safeFetch";
import { createHttpServer } from "./server";
import { healthSnapshot } from "./health/health";
import { R2Storage } from "./storage/R2Storage";
import { ViberAdapter } from "./viber/ViberAdapter";
import { WhatsAppAdapter } from "./whatsapp/WhatsAppAdapter";

export interface Collector {
  config: Config;
  server: Server;
  service: MediaIngestionService;
  queue: PersistentQueue;
  logger: Logger;
  audit: Audit;
  metrics: Metrics;
  adapters: MediaSourceAdapter[];
  /** Loads the queue, starts the worker, heartbeat and platform probes. */
  start(): Promise<void>;
  /** Graceful stop: no new webhooks, running jobs reach a saved state, final heartbeat. */
  stop(): Promise<void>;
}

export interface CollectorOptions {
  logger?: Logger;
  /** Tests only: allow http and private addresses for media downloads and uploads. */
  insecureLocalNetwork?: boolean;
  adminToken?: string | null;
  now?: () => Date;
  random?: () => number;
  /** Skip timers (tests drive heartbeat/probes explicitly). */
  timers?: boolean;
}

export function createCollector(config: Config, opts: CollectorOptions = {}): Collector {
  const logger =
    opts.logger ??
    createLogger({ level: config.logLevel, secrets: config.secrets, salt: config.collectorId, logMessageContent: config.logMessageContent, base: { service: "okb-media-collector" } });
  const audit = createAudit(logger, join(config.dataDir, "audit"));
  const metrics = new Metrics();
  const queue = new PersistentQueue(config.dataDir, config.queue.maxItems, config.queue.maxDiskBytes);
  const insecure = opts.insecureLocalNetwork === true;
  if (insecure && config.production) throw new Error("insecureLocalNetwork is not allowed in production");
  const policy = (hosts: string[]): FetchPolicy => ({ allowedHosts: hosts, allowHttp: insecure, allowPrivateAddresses: insecure });
  const adapters: MediaSourceAdapter[] = [
    new WhatsAppAdapter(config.whatsapp, policy(config.whatsapp.mediaHosts)),
    new ViberAdapter(config.viber, policy(config.viber.mediaHosts)),
  ];
  const backend = new OKBApiClient(config.backend.url, config.backend.token, config.backend.timeoutMs, config.collectorId);
  const r2 = new R2Storage(config.limits.downloadTimeoutMs, insecure);
  const service = new MediaIngestionService({ config, adapters, queue, backend, r2, logger, audit, metrics, now: opts.now, random: opts.random });
  const adminToken = opts.adminToken !== undefined ? opts.adminToken : process.env.COLLECTOR_ADMIN_TOKEN?.trim() || null;
  const server = createHttpServer({ config, adapters, service, queue, logger, audit, metrics, adminToken });

  metrics.gauge("queue_pending", () => queue.stats().pending);
  metrics.gauge("queue_failed", () => queue.stats().failed);
  metrics.gauge("queue_disk_bytes", () => queue.stats().diskBytes);
  for (const s of ["whatsapp", "viber"] as const) {
    metrics.gauge(`platform_connected{source="${s}"}`, () => (service.platformState.get(s)?.probe?.status === "connected" ? 1 : 0));
  }

  const timers: NodeJS.Timeout[] = [];
  const beat = () => service.heartbeat(healthSnapshot(config, service, queue));

  return {
    config, server, service, queue, logger, audit, metrics, adapters,
    async start() {
      const { recovered, orphansRemoved } = queue.load();
      audit.record("collector_started", {
        collectorId: config.collectorId, recovered, orphansRemoved,
        whatsapp: config.whatsapp.enabled ? "enabled" : "disabled", viber: config.viber.enabled ? "enabled" : "disabled",
      });
      if (config.viber.enabled && config.viber.allowedGroups.length > 0) {
        logger.warn("viber.groups_unsupported", {
          code: "VIBER_MEDIA_CAPTURE_UNSUPPORTED", note: "VIBER_ALLOWED_GROUP_IDS is set, but the official Viber Bot API cannot receive group messages; it is ignored",
        });
      }
      if (opts.timers !== false) {
        await Promise.allSettled([service.probePlatforms(), beat()]);
        timers.push(setInterval(() => void beat(), config.backend.heartbeatIntervalMs));
        timers.push(setInterval(() => void service.probePlatforms(), 10 * 60_000));
        for (const t of timers) t.unref();
      }
      service.start();
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.stop();
      audit.record("collector_stopped", { collectorId: config.collectorId, pending: queue.stats().pending });
      if (opts.timers !== false) await beat().catch(() => undefined);
    },
  };
}
