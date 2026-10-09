/**
 * Filename handling. A user-controlled filename never decides a storage path: the backend chooses the R2 key
 * (`<source>/YYYY/MM/DD/<uuid>-<safe name>`); this module only produces a safe, bounded display/stem name with
 * the extension of the DETECTED file type.
 */

const MAX_STEM = 80;

/** Last path segment only, without control characters, bounded. Kept for the record ("original filename"). */
export function originalFileName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "").trim().slice(0, 255);
  return cleaned || null;
}

/** Lower-case extension of a filename (letters/digits only), or null. */
export function extensionOf(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Safe storage name: ASCII letters, digits, ".", "_", "-" only; no leading dots (no hidden files), no "..",
 * no path separators, at most 80 characters before the extension; the extension is always `ext` (the detected
 * type), never the one supplied by the sender.
 */
export function safeFileName(name: string | null | undefined, ext: string): string {
  const base = originalFileName(name) ?? "";
  const stem = base
    .replace(/\.[^.]*$/, "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, MAX_STEM)
    .replace(/[-.]+$/g, "");
  const safeExt = /^[a-z0-9]{1,5}$/.test(ext) ? ext : "bin";
  return `${stem || "media"}.${safeExt}`;
}
