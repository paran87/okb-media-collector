import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Transform, type TransformCallback } from "node:stream";

export const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class SizeLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`file exceeds the ${limit}-byte limit`);
    this.name = "SizeLimitError";
  }
}

/**
 * Pass-through stream that hashes (SHA-256) and counts bytes, and aborts as soon as `maxBytes` is exceeded —
 * so an oversized or endless download never fills memory or disk.
 */
export class HashingLimiter extends Transform {
  private readonly hash: Hash = createHash("sha256");
  bytes = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      cb(new SizeLimitError(this.maxBytes));
      return;
    }
    this.hash.update(chunk);
    cb(null, chunk);
  }

  digest(): string {
    return this.hash.digest("hex");
  }
}

/**
 * Compares our SHA-256 with a checksum the platform declared. Platforms are inconsistent about hex vs base64,
 * so both encodings are accepted; an unparseable declared value is treated as "not provided".
 * @returns true (match), false (mismatch), null (nothing comparable was declared)
 */
export function matchesDeclaredSha256(ourHex: string, declared: string | null | undefined): boolean | null {
  if (!declared || typeof declared !== "string") return null;
  const d = declared.trim();
  if (/^[0-9a-fA-F]{64}$/.test(d)) return d.toLowerCase() === ourHex;
  if (/^[A-Za-z0-9+/]{43}=?$/.test(d) || /^[A-Za-z0-9_-]{43}$/.test(d)) {
    const ours = Buffer.from(ourHex, "hex");
    return d.replace(/=$/, "") === ours.toString("base64").replace(/=$/, "") || d === ours.toString("base64url");
  }
  return null;
}
