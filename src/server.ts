import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MediaSourceAdapter } from "./adapters/MediaSourceAdapter";
import type { Config } from "./config/environment";
import type { Audit } from "./logging/audit";
import type { Logger } from "./logging/logger";
import type { Metrics } from "./logging/metrics";
import type { MediaIngestionService } from "./okb/MediaIngestionService";
import type { PersistentQueue } from "./queue/PersistentQueue";
import { bearerAuthorized } from "./security/authentication";
import { healthSnapshot } from "./health/health";

/**
 * HTTP surface (nothing else is served):
 *   GET  /health                    public health (no ids, content or secrets)
 *   GET  /metrics                   Prometheus text; Bearer METRICS_TOKEN (disabled when unset)
 *   GET  /webhooks/whatsapp         Meta webhook verification (only when WhatsApp is enabled)
 *   POST /webhooks/whatsapp         Cloud API webhook (X-Hub-Signature-256 required)
 *   POST /webhooks/viber            Viber Bot API callback (X-Viber-Content-Signature required)
 *   POST /admin/queue/retry-failed  put failed jobs back in the queue; Bearer COLLECTOR_ADMIN_TOKEN
 */

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers["content-length"] ?? 0);
    if (len > limit) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string, contentType = "application/json; charset=utf-8"): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body));

export interface ServerDeps {
  config: Config;
  adapters: MediaSourceAdapter[];
  service: MediaIngestionService;
  queue: PersistentQueue;
  logger: Logger;
  audit: Audit;
  metrics: Metrics;
  adminToken: string | null;
}

export function createHttpServer(d: ServerDeps): Server {
  const byPath = new Map(d.adapters.filter((a) => a.enabled).map((a) => [a.webhookPath, a]));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, healthSnapshot(d.config, d.service, d.queue));

    if (req.method === "GET" && url.pathname === "/metrics") {
      if (!bearerAuthorized(req.headers, d.config.metricsToken)) return json(res, d.config.metricsToken ? 401 : 404, { error: "not available" });
      return send(res, 200, d.metrics.render(), "text/plain; version=0.0.4");
    }

    if (req.method === "POST" && url.pathname === "/admin/queue/retry-failed") {
      if (!bearerAuthorized(req.headers, d.adminToken)) return json(res, d.adminToken ? 401 : 404, { error: "not available" });
      const n = d.queue.retryFailed();
      d.service.kick();
      d.logger.info("admin.retry_failed", { requeued: n });
      return json(res, 200, { requeued: n });
    }

    const adapter = byPath.get(url.pathname);
    if (!adapter) return json(res, 404, { error: "not found" });
    let rawBody: Buffer;
    try {
      rawBody = req.method === "POST" ? await readBody(req, d.config.limits.webhookMaxBodyBytes) : Buffer.alloc(0);
    } catch (err) {
      if (err instanceof BodyTooLarge) return json(res, 413, { error: "payload too large" });
      throw err;
    }
    const result = await adapter.handleWebhook({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, rawBody });
    if (result.signature === "invalid") {
      d.metrics.inc("webhook_signature_failures_total", { source: adapter.source });
      d.audit.record("webhook_signature_invalid", { source: adapter.source, method: req.method });
    }
    if (result.messages.length) {
      const { queueFull } = d.service.intake(adapter.source, result.messages);
      // Queue full: 503 so the platform redelivers later (queued messages are deduplicated on redelivery).
      if (queueFull) return json(res, 503, { error: "temporarily unavailable" });
    }
    return send(res, result.response.status, result.response.body, result.response.contentType ?? "text/plain; charset=utf-8");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      d.logger.error("http.unhandled", { error: err });
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
