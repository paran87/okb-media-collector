import type { IncomingHttpHeaders } from "node:http";
import type { AllowlistEntry } from "../config/environment";
import type { AdapterMode, NormalizedMedia, NormalizedMessage, Source } from "../model/message";

/**
 * Platform-independent adapter contract. Each platform lives in its own folder (src/whatsapp, src/viber) and
 * implements this interface; the ingestion service, queue, storage and backend client never branch on the
 * platform. An unofficial/experimental integration would be a separate adapter with `mode: "experimental"`,
 * its own dependencies and its own enable flag — none is included (see docs/CAPABILITIES.md).
 */

export interface WebhookRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
}

export interface WebhookResponse {
  status: number;
  body: string;
  contentType?: string;
}

export interface WebhookResult {
  response: WebhookResponse;
  /** Messages normalized from a verified webhook (before allowlist filtering). */
  messages: NormalizedMessage[];
  /** Verified webhook events that carried nothing to collect (receipts, joins, …), counted only. */
  skipped: number;
  signature: "valid" | "invalid" | "not_applicable";
}

export interface MediaDownload {
  /** Response whose body is the file. */
  response: Response;
  /** Size the platform declares (null when unknown). */
  declaredSize: number | null;
  /** MIME type the platform declares (untrusted). */
  declaredMime: string | null;
  /** Checksum the platform declares (WhatsApp), compared after download. */
  declaredSha256: string | null;
}

export type PlatformStatus = "disabled" | "connected" | "auth_error" | "unreachable" | "error" | "unsupported" | "unknown";

export interface PlatformProbe {
  status: PlatformStatus;
  detail: string | null;
  checkedAt: string;
}

export interface Capability {
  feature: string;
  status: "supported" | "unsupported" | "limited" | "not_documented";
  note: string;
}

export interface MediaSourceAdapter {
  readonly source: Source;
  readonly mode: AdapterMode;
  readonly enabled: boolean;
  /** Webhook path served for this platform, e.g. "/webhooks/whatsapp". */
  readonly webhookPath: string;
  /** Whether the platform's official API can deliver group messages to this integration at all. */
  readonly groupCaptureSupported: boolean;
  readonly allowedGroups: AllowlistEntry[];
  readonly allowedSenders: AllowlistEntry[];

  /** Verifies and normalizes one webhook request. Never throws for bad input: answers with a status instead. */
  handleWebhook(req: WebhookRequest): Promise<WebhookResult>;
  /** Opens the download of one media item through the platform's supported mechanism. */
  fetchMedia(media: NormalizedMedia, signal: AbortSignal): Promise<MediaDownload>;
  /** Live credential/connection check for /health (never reports "connected" without a successful API call). */
  probe(): Promise<PlatformProbe>;
  capabilities(): Capability[];
}
