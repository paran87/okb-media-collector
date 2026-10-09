import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** Constant-time comparison of two strings (different lengths compare unequal without leaking where). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "okb-compare").update(a).digest();
  const hb = createHmac("sha256", "okb-compare").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Hex HMAC-SHA256 of the exact raw request bytes. */
export function hmacSha256Hex(secret: string, raw: Buffer): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

/**
 * Verifies a webhook signature computed over the raw body (never over re-serialized JSON).
 * `provided` may carry a prefix such as "sha256=" (WhatsApp X-Hub-Signature-256).
 */
export function verifyHmacSignature(secret: string, raw: Buffer, provided: string | undefined, prefix = ""): boolean {
  if (!secret || typeof provided !== "string") return false;
  const value = prefix ? (provided.startsWith(prefix) ? provided.slice(prefix.length) : "") : provided;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return false;
  return safeEqual(hmacSha256Hex(secret, raw), value.toLowerCase());
}

export function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Bearer token check for the collector's own admin/metrics endpoints. A missing configured token denies all. */
export function bearerAuthorized(headers: IncomingHttpHeaders, expected: string | null): boolean {
  if (!expected) return false;
  const m = /^Bearer (.+)$/.exec(header(headers, "authorization") ?? "");
  return Boolean(m && safeEqual(m[1]!, expected));
}
