import { createReadStream } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { PermanentError, TransientError, isTransientStatus } from "../queue/retry";

/**
 * Upload of an original file to Cloudflare R2.
 *
 * The collector holds NO R2 credentials: the existing OKB backend (which already owns the R2 client and keys)
 * issues a short-lived presigned PUT URL scoped to one object key and one Content-Type, and the file is
 * streamed from disk to that URL with an explicit Content-Length (no buffering of large videos in memory).
 * The backend later verifies the object (HEAD: exists, size) before it records the media as stored.
 */
export class R2Storage {
  constructor(
    private readonly timeoutMs: number,
    private readonly allowHttp = false,
  ) {}

  put(filePath: string, size: number, uploadUrl: string, headers: Record<string, string>): Promise<{ etag: string | null }> {
    let url: URL;
    try {
      url = new URL(uploadUrl);
    } catch {
      return Promise.reject(new PermanentError("invalid upload URL", "invalid_upload_url"));
    }
    if (url.protocol !== "https:" && !(this.allowHttp && url.protocol === "http:")) {
      return Promise.reject(new PermanentError("upload URL must use https", "insecure_upload_url"));
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send(
        url,
        { method: "PUT", headers: { ...headers, "Content-Length": String(size) }, timeout: this.timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          let len = 0;
          res.on("data", (c: Buffer) => {
            if (len < 4096) chunks.push(c);
            len += c.length;
          });
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              const etag = res.headers.etag;
              resolve({ etag: typeof etag === "string" ? etag.replace(/"/g, "") : null });
              return;
            }
            const body = Buffer.concat(chunks).toString("utf8");
            const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? `http_${status}`;
            // An expired presigned URL is answered 403: a new URL fixes it, so it is transient.
            const msg = `R2 upload failed (HTTP ${status} ${code})`;
            reject(isTransientStatus(status) ? new TransientError(msg, `r2_${code}`, status) : new PermanentError(msg, `r2_${code}`, status));
          });
        },
      );
      req.on("timeout", () => req.destroy(Object.assign(new Error("R2 upload timed out"), { name: "TimeoutError" })));
      req.on("error", (err) => reject(new TransientError(`R2 upload: ${err.message}`, err.name === "TimeoutError" ? "timeout" : "r2_network")));
      const file = createReadStream(filePath);
      file.on("error", (err) => req.destroy(err));
      file.pipe(req);
    });
  }
}
