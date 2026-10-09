import { open } from "node:fs/promises";

/**
 * Read-only inspection of a ZIP container's central directory (Office Open XML: DOCX/XLSX/PPTX).
 * Nothing is extracted or decompressed: the declared entry sizes are checked so a decompression bomb, a
 * "zip slip" entry name, encrypted entries or macros are rejected before the file is accepted.
 */

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressed: number;
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 5000, maxTotalUncompressed: 512 * 1024 * 1024, maxRatio: 200 };

export type ZipInspection =
  | { ok: true; names: string[] }
  | { ok: false; reason: string };

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;

export async function inspectZip(path: string, size: number, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipInspection> {
  if (size < 22) return { ok: false, reason: "zip_truncated" };
  const fh = await open(path, "r");
  try {
    // End of central directory: within the last 22 + 65535 (comment) bytes.
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return { ok: false, reason: "zip_no_central_directory" };
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { ok: false, reason: "zip64_not_supported" };
    if (entries > limits.maxEntries) return { ok: false, reason: "zip_too_many_entries" };
    if (cdOffset + cdSize > size || cdSize > 64 * 1024 * 1024) return { ok: false, reason: "zip_malformed" };

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const names: string[] = [];
    let total = 0;
    let p = 0;
    for (let n = 0; n < entries; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CDH_SIG) return { ok: false, reason: "zip_malformed" };
      const flags = cd.readUInt16LE(p + 8);
      const compressed = cd.readUInt32LE(p + 20);
      const uncompressed = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      if (p + 46 + nameLen > cd.length) return { ok: false, reason: "zip_malformed" };
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      if (flags & 0x1) return { ok: false, reason: "zip_encrypted_entry" };
      if (compressed === 0xffffffff || uncompressed === 0xffffffff) return { ok: false, reason: "zip64_not_supported" };
      if (name.startsWith("/") || name.startsWith("\\") || /(^|[\\/])\.\.([\\/]|$)/.test(name) || /^[A-Za-z]:/.test(name)) {
        return { ok: false, reason: "zip_unsafe_entry_name" };
      }
      total += uncompressed;
      if (total > limits.maxTotalUncompressed) return { ok: false, reason: "zip_decompression_bomb" };
      if (uncompressed > 1024 * 1024 && (compressed === 0 || uncompressed / compressed > limits.maxRatio)) {
        return { ok: false, reason: "zip_decompression_bomb" };
      }
      names.push(name);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { ok: true, names };
  } finally {
    await fh.close();
  }
}
