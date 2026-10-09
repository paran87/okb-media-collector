import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound fetch for media downloads with an allowlist of hosts. Media URLs come from platform webhooks/APIs;
 * this keeps a forged or unexpected URL from making the collector reach internal services (SSRF):
 *   - https only (http only when explicitly allowed for local tests),
 *   - the host must equal or be a subdomain of an allowlisted host,
 *   - the host must not resolve to a private, loopback or link-local address (unless allowed for tests),
 *   - redirects are followed manually (max 3) and every hop is checked again.
 */

export interface FetchPolicy {
  allowedHosts: string[];
  allowHttp?: boolean;
  allowPrivateAddresses?: boolean;
}

export class BlockedUrlError extends Error {
  constructor(reason: string) {
    super(`media URL blocked: ${reason}`);
    this.name = "BlockedUrlError";
  }
}

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
}

export async function checkUrl(raw: string, policy: FetchPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("not a URL");
  }
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) throw new BlockedUrlError("protocol not allowed");
  if (url.username || url.password) throw new BlockedUrlError("credentials in URL");
  if (!hostAllowed(url.hostname, policy.allowedHosts)) throw new BlockedUrlError("host not allowlisted");
  if (!policy.allowPrivateAddresses) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    if (addrs.length === 0 || addrs.some(privateAddress)) throw new BlockedUrlError("host resolves to a private address");
  }
  return url;
}

export async function safeFetch(raw: string, init: RequestInit, policy: FetchPolicy): Promise<Response> {
  let current = raw;
  for (let hop = 0; hop <= 3; hop++) {
    const url = await checkUrl(current, policy);
    const res = await fetch(url, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => undefined);
      current = new URL(res.headers.get("location")!, url).toString();
      // Credentials are never forwarded to a different host.
      if (new URL(current).host !== url.host && init.headers) init = { ...init, headers: {} };
      continue;
    }
    return res;
  }
  throw new BlockedUrlError("too many redirects");
}
