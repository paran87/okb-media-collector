/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { createCollector, type Collector } from "../../src/app";
import type { Config } from "../../src/config/environment";
import { createLogger } from "../../src/logging/logger";
import { SECRETS, testConfig } from "./config";

/**
 * End-to-end test environment:
 *   fake platform (Graph API + WhatsApp media + Viber API/media)  <- collector -> proxy -> REAL okb-bridge-cloud-backend
 *                                                                                    (in-memory storage) -> fake R2
 * The backend is loaded from OKB_BACKEND_DIR (default: ../okb-bridge-cloud-backend next to this repository).
 */

export const BACKEND_DIR = process.env.OKB_BACKEND_DIR ?? resolve(__dirname, "..", "..", "..", "..", "okb-bridge-cloud-backend");
export const backendAvailable = existsSync(join(BACKEND_DIR, "server.js")) && existsSync(join(BACKEND_DIR, "lib", "collector", "ingestion.js"));

const ADMIN_TOKEN = "backend-admin-token-for-tests-0001";
const DEVICE_TOKEN = "backend-device-token-for-tests-001";

function listen(server: Server): Promise<string> {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((r) => {
    const c: Buffer[] = [];
    req.on("data", (x: Buffer) => c.push(x));
    req.on("end", () => r(Buffer.concat(c)));
  });
}

export interface PlatformFile {
  bytes: Buffer;
  mime: string;
  declareSize?: boolean;
  /** Fail this many downloads with HTTP 500 first. */
  failTimes?: number;
  hang?: boolean;
}

/** WhatsApp Graph API + media host + Viber API + media host on one local server. */
export async function fakePlatform() {
  const files = new Map<string, PlatformFile>();
  const requests: string[] = [];
  let waTokenValid = true;
  let base = "";
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(`${req.method} ${url.pathname}`);
    const waAuth = req.headers.authorization === `Bearer ${SECRETS.waAccessToken}` && waTokenValid;
    const j = (status: number, o: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (url.pathname === "/pa/get_account_info") {
      await body(req);
      return j(200, req.headers["x-viber-auth-token"] === SECRETS.viberToken ? { status: 0, webhook: "https://collector.example/webhooks/viber" } : { status: 2, status_message: "invalidAuthToken" });
    }
    const graph = /^\/v23\.0\/([^/]+)$/.exec(url.pathname);
    if (graph) {
      if (!waAuth) return j(401, { error: { message: "Invalid OAuth access token" } });
      const id = decodeURIComponent(graph[1]!);
      if (url.searchParams.get("fields") === "id") return j(200, { id });
      const f = files.get(id);
      if (!f) return j(404, { error: { message: "media not found" } });
      return j(200, {
        url: `${base}/wa-files/${encodeURIComponent(id)}`, mime_type: f.mime, id,
        sha256: createHash("sha256").update(f.bytes).digest("hex"), ...(f.declareSize === false ? {} : { file_size: f.bytes.length }),
      });
    }
    const file = /^\/(wa-files|viber-files)\/(.+)$/.exec(url.pathname);
    if (file) {
      if (file[1] === "wa-files" && !waAuth) return j(401, {});
      const f = files.get(decodeURIComponent(file[2]!));
      if (!f) return j(404, {});
      if (f.hang) return; // never answers: download timeout
      if (f.failTimes && f.failTimes > 0) {
        f.failTimes--;
        return j(500, {});
      }
      res.writeHead(200, { "Content-Type": f.mime });
      return res.end(f.bytes);
    }
    j(404, {});
  });
  base = await listen(server);
  return {
    base, files, requests, server,
    setWhatsAppTokenValid(v: boolean) {
      waTokenValid = v;
    },
    viberUrl: (id: string) => `${base}/viber-files/${encodeURIComponent(id)}`,
  };
}

/** S3/R2 stand-in for presigned PUT / HEAD. */
export async function fakeR2() {
  const objects = new Map<string, { bytes: Buffer; contentType: string | undefined; contentLength: string | undefined }>();
  let failPuts = 0;
  let failStatus = 500;
  const server = createServer(async (req, res) => {
    const key = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname.slice(1));
    if (req.method === "PUT") {
      const b = await body(req);
      if (failPuts > 0) {
        failPuts--;
        res.writeHead(failStatus);
        return res.end(failStatus === 403 ? "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>" : "<Error><Code>InternalError</Code></Error>");
      }
      objects.set(key, { bytes: b, contentType: req.headers["content-type"], contentLength: req.headers["content-length"] });
      res.writeHead(200, { ETag: '"e"' });
      return res.end();
    }
    if (req.method === "HEAD") {
      const o = objects.get(key);
      res.writeHead(o ? 200 : 404, o ? { "Content-Length": o.bytes.length } : {});
      return res.end();
    }
    res.writeHead(405);
    res.end();
  });
  const base = await listen(server);
  const url = (k: string) => `${base}/${encodeURIComponent(k)}`;
  return {
    server, objects,
    failNextPuts(n: number, status = 500) {
      failPuts = n;
      failStatus = status;
    },
    client: {
      presignPut: (k: string, o: { contentType?: string } = {}) => ({ url: url(k), method: "PUT", headers: o.contentType ? { "Content-Type": o.contentType } : {}, expiresAt: new Date(Date.now() + 9e5).toISOString(), objectKey: k }),
      presignHead: (k: string) => ({ url: url(k) }),
      presignGet: (k: string) => ({ url: url(k) }),
      presignDelete: (k: string) => ({ url: url(k) }),
      remoteRef: (k: string) => `r2://okb-test/${k}`,
    },
  };
}

/** The real backend (createServer from okb-bridge-cloud-backend) with in-memory persistence. */
export async function realBackend(r2Client: unknown) {
  const req = require; // eslint-disable-line
  const { createServer: createBackend } = req(join(BACKEND_DIR, "server.js"));
  const { memoryConsolidatedStore } = req(join(BACKEND_DIR, "lib", "consolidated", "memory-store.js"));
  const { memoryCollectorStore } = req(join(BACKEND_DIR, "lib", "collector", "memory-store.js"));
  const { offlineAi } = req(join(BACKEND_DIR, "test", "helpers", "flood-fixtures.js"));
  const s = { messages: [] as any[], media: [] as any[], links: [] as any[] };
  const collectorStore = memoryCollectorStore();
  const persistence = {
    ...memoryConsolidatedStore(),
    ...collectorStore,
    async loadState() {
      return { devices: {}, messages: [], media: [], mediaLinks: [], reports: [], processingLogs: [] };
    },
    async upsertDevice() {},
    async insertMessage(m: any) { s.messages.push({ ...m }); },
    async updateMessageLastSeen() {},
    async upsertMedia(m: any) { s.media.push({ ...m }); },
    async insertMediaLink(l: any) { s.links.push({ ...l }); },
    async upsertReport() {},
    async appendProcessingLog() {},
  };
  const server: any = await createBackend({
    tokens: [DEVICE_TOKEN], adminTokens: [ADMIN_TOKEN], collectorTokens: [SECRETS.backendToken], log: () => {}, ai: offlineAi(), persistence, r2Client,
  });
  const base = await listen(server);
  return {
    base, server, state: s,
    ingestions: () => [...(collectorStore as any)._collector.ingestions.values()] as any[],
    admin: (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) } }),
  };
}

/** Pass-through proxy in front of the backend that can simulate an outage (503 or connection refused-like). */
export async function backendProxy(target: () => string) {
  let down = false;
  const server = createServer(async (req, res) => {
    if (down) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end('{"error":"service unavailable"}');
    }
    const b = await body(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "content-length", "connection"].includes(k)) headers[k] = v;
    const r = await fetch(`${target()}${req.url}`, { method: req.method, headers, body: b.length ? b : undefined });
    const out = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "application/json" });
    res.end(out);
  });
  const base = await listen(server);
  return {
    base, server,
    setDown(v: boolean) {
      down = v;
    },
  };
}

export interface Env {
  platform: Awaited<ReturnType<typeof fakePlatform>>;
  r2: Awaited<ReturnType<typeof fakeR2>>;
  backend: Awaited<ReturnType<typeof realBackend>>;
  proxy: Awaited<ReturnType<typeof backendProxy>>;
  collector: Collector;
  base: string;
  config: Config;
  logs: string[];
  makeCollector(config?: Config): Promise<{ collector: Collector; base: string }>;
  close(): Promise<void>;
}

export async function environment(patch: (c: Config) => void = () => undefined): Promise<Env> {
  const platform = await fakePlatform();
  const r2 = await fakeR2();
  const backend = await realBackend(r2.client);
  const proxy = await backendProxy(() => backend.base);
  const logs: string[] = [];
  const config = testConfig({ OKB_BACKEND_URL: proxy.base, WHATSAPP_GRAPH_BASE_URL: platform.base, VIBER_API_BASE_URL: `${platform.base}/pa` }, patch);
  const collectors: Collector[] = [];
  async function makeCollector(c: Config = config) {
    const logger = createLogger({ level: "debug", secrets: c.secrets, write: (l) => logs.push(l) });
    const collector = createCollector(c, { logger, insecureLocalNetwork: true, adminToken: "collector-admin-token-0123456789", timers: false });
    await collector.start();
    const base = await listen(collector.server);
    collectors.push(collector);
    return { collector, base };
  }
  const first = await makeCollector();
  return {
    platform, r2, backend, proxy, config, logs, makeCollector,
    collector: first.collector, base: first.base,
    async close() {
      for (const c of collectors) await c.stop().catch(() => undefined);
      await backend.server.okb.reports.drain();
      for (const s of [platform.server, r2.server, backend.server, proxy.server]) s.close();
    },
  };
}

export async function waitFor(pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Every log line plus the audit files of a data dir. */
export function allLogText(env: Env, dataDirs: string[] = [env.config.dataDir]): string {
  const audit: string[] = [];
  for (const d of dataDirs) {
    const dir = join(d, "audit");
    if (existsSync(dir)) for (const f of readdirSync(dir)) audit.push(readFileSync(join(dir, f), "utf8"));
  }
  return `${env.logs.join("\n")}\n${audit.join("\n")}`;
}
