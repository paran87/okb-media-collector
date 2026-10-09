/**
 * Configuration from environment variables. Validated once at startup; the service refuses to start with an
 * unsafe or incomplete configuration instead of running in a half-working state.
 *
 * Secrets are read here and nowhere else, and are registered with the logger so they are redacted from every
 * log line even if an error message happens to contain one.
 */

export interface AllowlistEntry {
  id: string;
  label: string | null;
}

export interface WhatsAppConfig {
  enabled: boolean;
  mode: "official";
  graphApiVersion: string;
  graphBaseUrl: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  phoneNumberId: string;
  allowedGroups: AllowlistEntry[];
  allowedSenders: AllowlistEntry[];
  mediaHosts: string[];
}

export interface ViberConfig {
  enabled: boolean;
  mode: "official";
  apiBaseUrl: string;
  authToken: string;
  allowedSenders: AllowlistEntry[];
  /** Accepted for completeness; the official Viber Bot API cannot receive group messages (see CAPABILITIES.md). */
  allowedGroups: AllowlistEntry[];
  mediaHosts: string[];
}

export interface Limits {
  maxImageBytes: number;
  maxDocumentBytes: number;
  maxVideoBytes: number;
  downloadTimeoutMs: number;
  webhookMaxBodyBytes: number;
}

export interface QueueConfig {
  maxItems: number;
  maxDiskBytes: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  concurrency: number;
}

export interface Config {
  env: string;
  production: boolean;
  host: string;
  port: number;
  collectorId: string;
  dataDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Message text in logs: never in production. */
  logMessageContent: boolean;
  backend: { url: string; token: string; timeoutMs: number; heartbeatIntervalMs: number };
  whatsapp: WhatsAppConfig;
  viber: ViberConfig;
  limits: Limits;
  queue: QueueConfig;
  metricsToken: string | null;
  /** Secret values to redact from logs. */
  secrets: string[];
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string, fallback = ""): string {
  const v = env[name];
  return v !== undefined && v.trim() !== "" ? v.trim() : fallback;
}

function bool(env: Env, name: string, fallback: boolean, problems: string[]): boolean {
  const v = str(env, name);
  if (!v) return fallback;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  problems.push(`${name} must be true or false`);
  return fallback;
}

function int(env: Env, name: string, fallback: number, problems: string[], min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = str(env, name);
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return n;
}

/**
 * "id" or "id|Display name", comma separated. IDs must be printable ASCII without spaces, "|" or ",".
 * ("=" cannot separate the label: Viber user ids are base64 and may end with "=".)
 */
export function parseAllowlist(raw: string, name: string, problems: string[]): AllowlistEntry[] {
  const out: AllowlistEntry[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const bar = item.indexOf("|");
    const id = (bar >= 0 ? item.slice(0, bar) : item).trim();
    const label = bar >= 0 ? item.slice(bar + 1).trim().slice(0, 100) || null : null;
    if (!/^[\x21-\x7e]{1,200}$/.test(id)) {
      problems.push(`${name} has an invalid id "${id.slice(0, 40)}"`);
      continue;
    }
    if (!seen.has(id)) out.push({ id, label });
    seen.add(id);
  }
  return out;
}

function hosts(raw: string): string[] {
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^\.+/, ""))
    .filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h));
}

const MB = 1024 * 1024;

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const nodeEnv = str(env, "NODE_ENV", "development");
  const production = nodeEnv === "production";

  const backendUrl = str(env, "OKB_BACKEND_URL").replace(/\/+$/, "");
  if (!backendUrl) problems.push("OKB_BACKEND_URL is required");
  else if (!/^https?:\/\//.test(backendUrl)) problems.push("OKB_BACKEND_URL must be an http(s) URL");
  else if (production && !backendUrl.startsWith("https://")) problems.push("OKB_BACKEND_URL must use https in production");
  const backendToken = str(env, "OKB_COLLECTOR_TOKEN");
  if (!backendToken) problems.push("OKB_COLLECTOR_TOKEN is required");
  else if (backendToken.length < 32) problems.push("OKB_COLLECTOR_TOKEN must be at least 32 characters (the backend ignores shorter collector tokens)");

  // ---- WhatsApp (official Cloud API only) ----
  const waEnabled = bool(env, "WHATSAPP_ENABLED", false, problems);
  const waMode = str(env, "WHATSAPP_MODE", "official");
  if (waMode !== "official") {
    problems.push('WHATSAPP_MODE must be "official": no unofficial WhatsApp adapter is included (see docs/CAPABILITIES.md)');
  }
  const whatsapp: WhatsAppConfig = {
    enabled: waEnabled,
    mode: "official",
    graphApiVersion: str(env, "WHATSAPP_GRAPH_API_VERSION"),
    graphBaseUrl: str(env, "WHATSAPP_GRAPH_BASE_URL", "https://graph.facebook.com").replace(/\/+$/, ""),
    accessToken: str(env, "WHATSAPP_ACCESS_TOKEN"),
    appSecret: str(env, "WHATSAPP_APP_SECRET"),
    verifyToken: str(env, "WHATSAPP_VERIFY_TOKEN"),
    phoneNumberId: str(env, "WHATSAPP_PHONE_NUMBER_ID"),
    allowedGroups: parseAllowlist(str(env, "WHATSAPP_ALLOWED_GROUP_IDS"), "WHATSAPP_ALLOWED_GROUP_IDS", problems),
    allowedSenders: parseAllowlist(str(env, "WHATSAPP_ALLOWED_SENDER_IDS"), "WHATSAPP_ALLOWED_SENDER_IDS", problems),
    mediaHosts: hosts(str(env, "WHATSAPP_MEDIA_HOSTS", "fbsbx.com,whatsapp.net")),
  };
  if (whatsapp.enabled) {
    for (const [k, v] of [
      ["WHATSAPP_GRAPH_API_VERSION", whatsapp.graphApiVersion],
      ["WHATSAPP_ACCESS_TOKEN", whatsapp.accessToken],
      ["WHATSAPP_APP_SECRET", whatsapp.appSecret],
      ["WHATSAPP_VERIFY_TOKEN", whatsapp.verifyToken],
      ["WHATSAPP_PHONE_NUMBER_ID", whatsapp.phoneNumberId],
    ] as const) {
      if (!v) problems.push(`${k} is required when WHATSAPP_ENABLED=true`);
    }
    if (whatsapp.graphApiVersion && !/^v\d+\.\d+$/.test(whatsapp.graphApiVersion)) {
      problems.push('WHATSAPP_GRAPH_API_VERSION must look like "v23.0"');
    }
    if (whatsapp.verifyToken && whatsapp.verifyToken.length < 16) problems.push("WHATSAPP_VERIFY_TOKEN must be at least 16 characters");
    if (whatsapp.allowedGroups.length === 0 && whatsapp.allowedSenders.length === 0) {
      problems.push("WHATSAPP_ENABLED=true needs WHATSAPP_ALLOWED_GROUP_IDS and/or WHATSAPP_ALLOWED_SENDER_IDS (nothing is collected by default)");
    }
    if (whatsapp.mediaHosts.length === 0) problems.push("WHATSAPP_MEDIA_HOSTS must list at least one host");
    if (production && !whatsapp.graphBaseUrl.startsWith("https://")) problems.push("WHATSAPP_GRAPH_BASE_URL must use https in production");
  }

  // ---- Viber (official REST Bot API only) ----
  const viber: ViberConfig = {
    enabled: bool(env, "VIBER_ENABLED", false, problems),
    mode: "official",
    apiBaseUrl: str(env, "VIBER_API_BASE_URL", "https://chatapi.viber.com/pa").replace(/\/+$/, ""),
    authToken: str(env, "VIBER_AUTH_TOKEN"),
    allowedSenders: parseAllowlist(str(env, "VIBER_ALLOWED_SENDER_IDS"), "VIBER_ALLOWED_SENDER_IDS", problems),
    allowedGroups: parseAllowlist(str(env, "VIBER_ALLOWED_GROUP_IDS"), "VIBER_ALLOWED_GROUP_IDS", problems),
    mediaHosts: hosts(str(env, "VIBER_MEDIA_HOSTS", "viber.com")),
  };
  if (str(env, "VIBER_MODE", "official") !== "official") {
    problems.push('VIBER_MODE must be "official": no unofficial Viber adapter is included (see docs/CAPABILITIES.md)');
  }
  if (viber.enabled) {
    if (!viber.authToken) problems.push("VIBER_AUTH_TOKEN is required when VIBER_ENABLED=true");
    if (viber.allowedSenders.length === 0) {
      problems.push("VIBER_ENABLED=true needs VIBER_ALLOWED_SENDER_IDS (the Viber Bot API only receives 1:1 messages; nothing is collected by default)");
    }
    if (viber.mediaHosts.length === 0) problems.push("VIBER_MEDIA_HOSTS must list at least one host");
  }

  const limits: Limits = {
    maxImageBytes: int(env, "MAX_IMAGE_SIZE_MB", 25, problems, 1, 1024) * MB,
    maxDocumentBytes: int(env, "MAX_DOCUMENT_SIZE_MB", 50, problems, 1, 1024) * MB,
    maxVideoBytes: int(env, "MAX_VIDEO_SIZE_MB", 200, problems, 1, 2048) * MB,
    downloadTimeoutMs: int(env, "DOWNLOAD_TIMEOUT_MS", 120_000, problems, 5_000, 3_600_000),
    webhookMaxBodyBytes: int(env, "WEBHOOK_MAX_BODY_KB", 1024, problems, 16, 10_240) * 1024,
  };

  const queue: QueueConfig = {
    maxItems: int(env, "QUEUE_MAX_ITEMS", 2000, problems, 10, 1_000_000),
    maxDiskBytes: int(env, "QUEUE_MAX_DISK_MB", 4096, problems, 100, 1_048_576) * MB,
    maxAttempts: int(env, "RETRY_MAX_ATTEMPTS", 15, problems, 1, 1000),
    baseDelayMs: int(env, "RETRY_BASE_DELAY_MS", 5_000, problems, 10, 3_600_000),
    maxDelayMs: int(env, "RETRY_MAX_DELAY_MS", 1_800_000, problems, 1_000, 86_400_000),
    concurrency: int(env, "WORKER_CONCURRENCY", 2, problems, 1, 16),
  };
  if (queue.maxDiskBytes < Math.max(limits.maxImageBytes, limits.maxDocumentBytes, limits.maxVideoBytes) * 2) {
    problems.push("QUEUE_MAX_DISK_MB must be at least twice the largest media size limit");
  }

  const logLevel = str(env, "LOG_LEVEL", "info");
  if (!["debug", "info", "warn", "error"].includes(logLevel)) problems.push("LOG_LEVEL must be debug, info, warn or error");
  const logMessageContent = bool(env, "LOG_MESSAGE_CONTENT", false, problems);
  if (logMessageContent && production) problems.push("LOG_MESSAGE_CONTENT=true is not allowed in production");

  const collectorId = str(env, "COLLECTOR_ID", "okb-media-collector");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(collectorId)) problems.push("COLLECTOR_ID may contain only letters, digits, . _ -");

  const metricsToken = str(env, "METRICS_TOKEN") || null;

  if (problems.length) throw new ConfigError(problems);

  const secrets = [backendToken, whatsapp.accessToken, whatsapp.appSecret, whatsapp.verifyToken, viber.authToken, metricsToken ?? ""]
    .filter((s) => s.length >= 8);

  return {
    env: nodeEnv,
    production,
    host: str(env, "HOST", "0.0.0.0"),
    port: int(env, "PORT", 8090, [], 0, 65535),
    collectorId,
    dataDir: str(env, "DATA_DIR", "./data"),
    logLevel: logLevel as Config["logLevel"],
    logMessageContent,
    backend: {
      url: backendUrl,
      token: backendToken,
      timeoutMs: int(env, "OKB_BACKEND_TIMEOUT_MS", 30_000, [], 1_000, 600_000),
      heartbeatIntervalMs: int(env, "HEARTBEAT_INTERVAL_MS", 60_000, [], 5_000, 3_600_000),
    },
    whatsapp,
    viber,
    limits,
    queue,
    metricsToken,
    secrets,
  };
}
