import { randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";

/** Minimal test files with real signatures. */

export function jpeg(size = 4096): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0"), randomBytes(Math.max(0, size - 13)), Buffer.from([0xff, 0xd9])]);
}

export function png(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(512)]);
}

export function mp4(): Buffer {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(24, 0);
  box.write("ftypisom", 4, "latin1");
  return Buffer.concat([box, randomBytes(2048)]);
}

export function pdf(body = "flood report"): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${body}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, "latin1");
}

interface ZipEntry {
  name: string;
  data: Buffer;
  /** Lie about the uncompressed size in the central directory (decompression-bomb fixture). */
  claimUncompressed?: number;
  encrypted?: boolean;
}

/** Stored (uncompressed) ZIP archive. */
export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const flags = e.encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, e.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.claimUncompressed ?? e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CT = Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');

export function docx(extra: ZipEntry[] = []): Buffer {
  return zip([
    { name: "[Content_Types].xml", data: CT },
    { name: "word/document.xml", data: Buffer.from("<w:document><w:body><w:p><w:r><w:t>Flood report</w:t></w:r></w:p></w:body></w:document>") },
    ...extra,
  ]);
}

export function xlsx(): Buffer {
  return zip([
    { name: "[Content_Types].xml", data: CT },
    { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
  ]);
}

export const OLE_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
export function ole(): Buffer {
  return Buffer.concat([OLE_HEADER, randomBytes(1024)]);
}

/** A Windows executable (MZ header) — must never be accepted, whatever it is called. */
export function exe(): Buffer {
  return Buffer.concat([Buffer.from("MZ"), randomBytes(1024)]);
}
