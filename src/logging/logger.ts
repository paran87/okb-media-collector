import { createHash } from "node:crypto";

/**
 * Structured JSON logger.
 *
 * - Keys that name credentials (token, secret, authorization, password, cookie, signature, url) are replaced by
 *   "[REDACTED]" wherever they appear in a log record.
 * - Every configured secret value is replaced by "[REDACTED]" anywhere in the serialized line, so a secret that
 *   ends up in an error message (e.g. an echoed URL) still never reaches the log.
 * - Platform ids (phone numbers, group ids) are logged only as short salted hashes (`ref()`).
 * - Message text is never logged unless LOG_MESSAGE_CONTENT=true outside production (`content()`).
 */

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /(token|secret|authorization|password|passwd|cookie|signature|api[-_]?key|downloadurl|uploadurl|^url$)/i;

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** Salted short hash of an identifier (phone number, group id) for correlation without exposure. */
  ref(id: string | null | undefined): string | null;
  /** Message content for logs: the text only when explicitly allowed, otherwise its length. */
  content(text: string | null | undefined): string | { length: number } | null;
}

export interface LoggerOptions {
  level?: Level;
  secrets?: string[];
  salt?: string;
  logMessageContent?: boolean;
  /** Output sink (default: stdout/stderr). */
  write?: (line: string, level: Level) => void;
  base?: Record<string, unknown>;
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (value instanceof Error) return { name: value.name, message: value.message, code: (value as { code?: unknown }).code };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : scrub(v, depth + 1);
    return out;
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = ORDER[opts.level ?? "info"];
  const secrets = (opts.secrets ?? []).filter((s) => s && s.length >= 8).sort((a, b) => b.length - a.length);
  const salt = opts.salt ?? "okb-media-collector";
  const write =
    opts.write ??
    ((line: string, level: Level) => (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`));

  function redact(line: string): string {
    let out = line;
    for (const s of secrets) if (out.includes(s)) out = out.split(s).join("[REDACTED]");
    // Also catch secrets that were JSON-escaped or URL-encoded.
    for (const s of secrets) {
      const enc = encodeURIComponent(s);
      if (enc !== s && out.includes(enc)) out = out.split(enc).join("[REDACTED]");
    }
    return out;
  }

  function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[level] < min) return;
    const record = { time: new Date().toISOString(), level, event, ...(opts.base ?? {}), ...(scrub(fields) as object) };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ time: record.time, level, event, note: "unserializable fields" });
    }
    write(redact(line), level);
  }

  return {
    debug: (e, f) => log("debug", e, f),
    info: (e, f) => log("info", e, f),
    warn: (e, f) => log("warn", e, f),
    error: (e, f) => log("error", e, f),
    ref: (id) => (id ? createHash("sha256").update(`${salt}|${id}`).digest("hex").slice(0, 12) : null),
    content: (text) => (text == null ? null : opts.logMessageContent ? text : { length: text.length }),
  };
}
