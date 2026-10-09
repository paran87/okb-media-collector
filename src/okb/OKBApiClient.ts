import type { MediaKind, MediaOutcome, NormalizedMessage } from "../model/message";
import { classifyNetworkError, isTransientStatus, PermanentError, TransientError } from "../queue/retry";

/**
 * Client for the existing OKB backend (okb-bridge-cloud-backend). Authenticates with the collector bearer token
 * (OKB_COLLECTOR_TOKEN, one of the backend's OKB_COLLECTOR_TOKENS) in the Authorization header — never in a
 * URL — and sends an Idempotency-Key with every write.
 */

export interface UploadUrlRequest {
  source: NormalizedMessage["source"];
  platformMessageId: string;
  platformMediaId: string | null;
  sha256: string;
  fileSizeBytes: number;
  mimeType: string;
  mediaKind: MediaKind;
  fileName: string | null;
  receivedAt: string;
}

export type UploadUrlResponse =
  | { status: "upload"; objectKey: string; uploadUrl: string; method: "PUT"; headers: Record<string, string>; expiresAt: string }
  | { status: "duplicate"; objectKey: string; mediaId: string }
  | { status: "already_registered"; objectKey: string | null; mediaId: string | null };

export interface RegisterResponse {
  status: "stored" | "duplicate";
  ingestionId: string;
  messageId: string;
  mediaId: string | null;
  objectKey: string | null;
  mediaStatus: string;
  duplicateOfMessageId: string | null;
}

export interface BackendHealth {
  status: string;
  media: string;
  mediaCollector?: string;
}

export interface HeartbeatResponse {
  settings: { whatsappPaused: boolean; viberPaused: boolean };
}

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

export class OKBApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly collectorId: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          "User-Agent": `okb-media-collector/${this.collectorId}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw classifyNetworkError(err, `backend ${path}`);
    }
    const text = await res.text().catch(() => "");
    let json: { error?: string; code?: string } & Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON error page (e.g. a proxy) */
    }
    if (!res.ok) {
      const message = `backend ${path}: HTTP ${res.status}${json.error ? ` (${String(json.error).slice(0, 200)})` : ""}`;
      const err = new BackendError(message, res.status, typeof json.code === "string" ? json.code : null);
      throw err;
    }
    return json as T;
  }

  uploadUrl(req: UploadUrlRequest, idempotencyKey: string): Promise<UploadUrlResponse> {
    return this.request("POST", "/api/v1/media-ingestion/upload-url", req, idempotencyKey);
  }

  register(message: NormalizedMessage, outcome: MediaOutcome | null, idempotencyKey: string): Promise<RegisterResponse> {
    return this.request(
      "POST",
      "/api/v1/media-ingestion",
      {
        source: message.source,
        mode: message.mode,
        collectorId: this.collectorId,
        conversationType: message.conversationType,
        platformMessageId: message.platformMessageId,
        platformMediaId: message.media?.platformMediaId ?? null,
        groupId: message.groupId,
        groupName: message.groupName,
        senderId: message.senderId,
        senderName: message.senderName,
        messageText: message.messageText,
        receivedAt: message.receivedAt,
        media: outcome,
      },
      idempotencyKey,
    );
  }

  heartbeat(snapshot: unknown): Promise<HeartbeatResponse> {
    return this.request("POST", "/api/v1/collector/heartbeat", { collectorId: this.collectorId, snapshot });
  }

  async health(): Promise<BackendHealth> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw classifyNetworkError(err, "backend health");
    }
    if (!res.ok) throw new BackendError(`backend health: HTTP ${res.status}`, res.status, null);
    return (await res.json()) as BackendHealth;
  }
}

/** Maps a backend failure to retry semantics for the queue. */
export function classifyBackendError(err: unknown): TransientError | PermanentError {
  if (err instanceof TransientError || err instanceof PermanentError) return err;
  if (err instanceof BackendError) {
    const code = err.code ?? `http_${err.status}`;
    return isTransientStatus(err.status) ? new TransientError(err.message, code, err.status) : new PermanentError(err.message, code, err.status);
  }
  return new TransientError(err instanceof Error ? err.message : String(err), "unexpected");
}
