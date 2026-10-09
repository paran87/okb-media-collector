import { open } from "node:fs/promises";
import type { Limits } from "../config/environment";
import type { MediaKind } from "../model/message";
import { extensionOf } from "./filename";
import { DEFAULT_ZIP_LIMITS, inspectZip, type ZipLimits } from "./zip";

/**
 * File validation. The MIME type and filename a platform (or sender) supplies are NOT trusted: the type is
 * decided from the file's own signature (magic bytes) and container structure, and then the declared MIME
 * type and the filename extension must agree with it. Anything unrecognised, inconsistent, oversized or
 * structurally unsafe is rejected. Files are only read — never opened by an application, executed or
 * converted — and the original bytes stay unchanged.
 */

export type StoredKind = "image" | "video" | "document";

export interface DetectedType {
  ext: string;
  mime: string;
  kind: StoredKind;
}

export type ValidationResult =
  | { ok: true; detected: DetectedType }
  | { ok: false; reason: RejectReason; detail?: string };

export type RejectReason =
  | "empty_file"
  | "size_limit_exceeded"
  | "unsupported_or_unrecognized_type"
  | "mime_type_mismatch"
  | "extension_mismatch"
  | "malformed_file"
  | "macro_content"
  | "zip_unsafe"
  | "text_not_utf8";

const MIME_EXT: Record<string, [StoredKind, string]> = {
  "image/jpeg": ["image", "jpg"],
  "image/png": ["image", "png"],
  "image/webp": ["image", "webp"],
  "image/heic": ["image", "heic"],
  "image/heif": ["image", "heif"],
  "video/mp4": ["video", "mp4"],
  "video/quicktime": ["video", "mov"],
  "video/3gpp": ["video", "3gp"],
  "application/pdf": ["document", "pdf"],
  "application/msword": ["document", "doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["document", "docx"],
  "application/vnd.ms-excel": ["document", "xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["document", "xlsx"],
  "application/vnd.ms-powerpoint": ["document", "ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["document", "pptx"],
  "text/plain": ["document", "txt"],
};

export const SUPPORTED_MIME_TYPES = Object.freeze(Object.keys(MIME_EXT));

const type = (mime: string): DetectedType => {
  const [kind, ext] = MIME_EXT[mime]!;
  return { mime, kind, ext };
};

/** Declared MIME aliases that mean the same detected type. */
const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/heic-sequence": "image/heic",
  "image/heif-sequence": "image/heif",
  "video/x-m4v": "video/mp4",
  "video/3gp": "video/3gpp",
  "application/x-pdf": "application/pdf",
};

/** MIME types that carry no type information (accepted, the signature decides). */
const GENERIC_MIME = new Set(["application/octet-stream", "binary/octet-stream", "application/unknown"]);

/** Extensions accepted for each detected extension. */
const EXT_ALIASES: Record<string, string[]> = {
  jpg: ["jpg", "jpeg", "jpe", "jfif"],
  png: ["png"],
  webp: ["webp"],
  heic: ["heic", "heif"],
  heif: ["heif", "heic"],
  mp4: ["mp4", "m4v"],
  mov: ["mov", "qt"],
  "3gp": ["3gp", "3gpp"],
  pdf: ["pdf"],
  doc: ["doc"],
  docx: ["docx"],
  xls: ["xls"],
  xlsx: ["xlsx"],
  ppt: ["ppt", "pps"],
  pptx: ["pptx"],
  txt: ["txt", "text"],
};

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const HEIF_BRANDS = new Set(["mif1", "msf1", "mif2"]);
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "m4v ", "m4vh", "m4vp", "dash", "mmp4", "msnv", "ndas", "f4v ", "xavc", "mp4v"]);

export function sizeLimitFor(kind: MediaKind | StoredKind, limits: Limits): number {
  if (kind === "image") return limits.maxImageBytes;
  if (kind === "video") return limits.maxVideoBytes;
  return limits.maxDocumentBytes;
}

/** The largest file the collector would ever accept (download cap when the kind is not yet known). */
export function maxAnyBytes(limits: Limits): number {
  return Math.max(limits.maxImageBytes, limits.maxVideoBytes, limits.maxDocumentBytes);
}

function normalizeMime(mime: string | null | undefined): string | null {
  if (typeof mime !== "string") return null;
  const m = mime.split(";")[0]!.trim().toLowerCase();
  if (!m) return null;
  return MIME_ALIASES[m] ?? m;
}

/** Detection from the first bytes. OLE/ZIP/text containers need more context (see detectFileType). */
function sniff(head: Buffer): DetectedType | "ole" | "zip" | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return type("image/jpeg");
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return type("image/png");
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return type("image/webp");
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    const brand = head.toString("latin1", 8, 12).toLowerCase();
    if (HEIC_BRANDS.has(brand)) return type("image/heic");
    if (HEIF_BRANDS.has(brand)) return type("image/heif");
    if (brand === "qt  ") return type("video/quicktime");
    if (brand.startsWith("3g")) return type("video/3gpp");
    if (MP4_BRANDS.has(brand)) return type("video/mp4");
    return null;
  }
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "ole";
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return "zip";
  const pdfAt = head.indexOf("%PDF-", 0, "latin1");
  if (pdfAt >= 0 && pdfAt < 1024) return type("application/pdf");
  return null;
}

function looksLikeUtf8Text(head: Buffer): boolean {
  if (head.length === 0) return false;
  if (head.includes(0)) return false;
  // Allow a multi-byte character cut at the end of the sample.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export interface ValidateInput {
  path: string;
  size: number;
  declaredMime: string | null;
  fileName: string | null;
  limits: Limits;
  zipLimits?: ZipLimits;
}

/** Ensures a PDF has an end-of-file marker near its end (truncated downloads are rejected as malformed). */
async function pdfLooksComplete(path: string, size: number): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const len = Math.min(size, 2048);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.includes("%%EOF", 0, "latin1");
  } finally {
    await fh.close();
  }
}

export async function validateFile(input: ValidateInput): Promise<ValidationResult> {
  const { path, size, limits } = input;
  if (size <= 0) return { ok: false, reason: "empty_file" };
  const declared = normalizeMime(input.declaredMime);
  const declaredExt = extensionOf(input.fileName);
  const head = await readHead(path, 64 * 1024);
  const sniffed = sniff(head);

  let detected: DetectedType | null = null;
  if (sniffed === "ole") {
    // Legacy Office (DOC/XLS/PPT) share one container; the declared type picks which, and must be one of them.
    const legacy = ["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"];
    const byMime = declared && legacy.includes(declared) ? declared : null;
    const byExt = legacy.find((m) => declaredExt && EXT_ALIASES[MIME_EXT[m]![1]]!.includes(declaredExt)) ?? null;
    const chosen = byMime ?? byExt;
    if (!chosen) return { ok: false, reason: "unsupported_or_unrecognized_type", detail: "ole_container_without_office_type" };
    detected = type(chosen);
  } else if (sniffed === "zip") {
    const zip = await inspectZip(path, size, input.zipLimits ?? DEFAULT_ZIP_LIMITS);
    if (!zip.ok) return { ok: false, reason: zip.reason === "zip_malformed" || zip.reason === "zip_truncated" || zip.reason === "zip_no_central_directory" ? "malformed_file" : "zip_unsafe", detail: zip.reason };
    const names = new Set(zip.names);
    if (!names.has("[Content_Types].xml")) return { ok: false, reason: "unsupported_or_unrecognized_type", detail: "zip_not_office" };
    if (zip.names.some((n) => /vbaProject\.bin$/i.test(n) || /\.bin$/i.test(n) && /activeX/i.test(n))) {
      return { ok: false, reason: "macro_content" };
    }
    if (names.has("word/document.xml")) detected = type("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    else if (names.has("xl/workbook.xml")) detected = type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    else if (names.has("ppt/presentation.xml")) detected = type("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    else return { ok: false, reason: "unsupported_or_unrecognized_type", detail: "zip_not_office" };
  } else if (sniffed) {
    detected = sniffed;
  } else if ((declared === "text/plain" || (declaredExt && EXT_ALIASES.txt!.includes(declaredExt))) && looksLikeUtf8Text(head)) {
    detected = type("text/plain");
  } else if (declared === "text/plain" || declaredExt === "txt") {
    return { ok: false, reason: "text_not_utf8" };
  }
  if (!detected) return { ok: false, reason: "unsupported_or_unrecognized_type" };

  // The declared MIME type must agree with the content.
  if (declared && !GENERIC_MIME.has(declared)) {
    const zipDeclared = declared === "application/zip" && detected.ext.endsWith("x") && detected.kind === "document";
    if (declared !== detected.mime && !zipDeclared) return { ok: false, reason: "mime_type_mismatch", detail: `${declared} vs ${detected.mime}` };
  }
  // The filename extension (when there is one) must agree with the content.
  if (declaredExt && !EXT_ALIASES[detected.ext]!.includes(declaredExt)) {
    return { ok: false, reason: "extension_mismatch", detail: `.${declaredExt} vs ${detected.ext}` };
  }
  if (size > sizeLimitFor(detected.kind, limits)) return { ok: false, reason: "size_limit_exceeded" };
  if (detected.mime === "application/pdf" && !(await pdfLooksComplete(path, size))) {
    return { ok: false, reason: "malformed_file", detail: "pdf_without_eof" };
  }
  return { ok: true, detected };
}
