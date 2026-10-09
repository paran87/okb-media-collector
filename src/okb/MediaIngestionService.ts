import { createWriteStream, existsSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { MediaSourceAdapter, PlatformProbe } from "../adapters/MediaSourceAdapter";
import type { Config } from "../config/environment";
import type { Audit } from "../logging/audit";
import type { Logger } from "../logging/logger";
import type { Metrics } from "../logging/metrics";
import { idempotencyKey, type MediaKind, type MediaOutcome, type NormalizedMessage, type Source } from "../model/message";
import type { Job, PersistentQueue } from "../queue/PersistentQueue";
import { backoffDelay, PermanentError, TransientError } from "../queue/retry";
import { Allowlist } from "../security/allowlist";
import { originalFileName } from "../security/filename";
import { HashingLimiter, matchesDeclaredSha256, SizeLimitError } from "../security/hashing";
import { maxAnyBytes, sizeLimitFor, validateFile } from "../security/validation";
import type { R2Storage } from "../storage/R2Storage";
import { BackendError, classifyBackendError, type OKBApiClient } from "./OKBApiClient";

/**
 * The platform-independent pipeline:
 *
 *   webhook -> adapter (verify + normalize) -> intake (pause flag, allowlist) -> durable queue
 *     -> download (stream to disk, size cap, SHA-256, signature validation)
 *     -> upload  (backend issues a presigned R2 PUT, or answers "duplicate" for known bytes)
 *     -> register (backend stores message + media outcome; existing report pipeline takes over)
 *
 * NEVER PRETEND A FILE WAS CAPTURED: every message is registered with the true media outcome — stored,
 * duplicate, media_unavailable (platform did not provide it, or the download failed for good), rejected
 * (failed validation) or not_collected (out of scope) — and the backend verifies a "stored" object in R2.
 */

export type ConnectionStatus = "unknown" | "connected" | "auth_error" | "unreachable" | "error";

interface Deps {
  config: Config;
  adapters: MediaSourceAdapter[];
  queue: PersistentQueue;
  backend: OKBApiClient;
  r2: R2Storage;
  logger: Logger;
  audit: Audit;
  metrics: Metrics;
  now?: () => Date;
  random?: () => number;
}

const COLLECTED_KINDS = new Set<MediaKind>(["image", "video", "document"]);
const DISK_WAIT_MS = 30_000;

export class MediaIngestionService {
  readonly startedAt = new Date();
  private readonly allowlists = new Map<Source, Allowlist>();
  private readonly adapters = new Map<Source, MediaSourceAdapter>();
  private readonly running = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  readonly paused: Record<Source, boolean> = { whatsapp: false, viber: false };

  readonly backendState = { status: "unknown" as ConnectionStatus, lastSuccessAt: null as string | null, lastError: null as string | null, media: null as string | null };
  readonly r2State = { lastUploadOk: null as boolean | null, lastUploadAt: null as string | null, lastError: null as string | null };
  readonly platformState = new Map<Source, { probe: PlatformProbe | null; lastWebhookAt: string | null }>();

  constructor(private readonly d: Deps) {
    for (const a of d.adapters) {
      this.adapters.set(a.source, a);
      this.allowlists.set(a.source, new Allowlist(a.allowedGroups, a.allowedSenders, a.groupCaptureSupported));
      this.platformState.set(a.source, { probe: null, lastWebhookAt: null });
    }
  }

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  // ---- intake ---------------------------------------------------------------------------------------

  /**
   * Filters and queues normalized messages from one verified webhook.
   * @returns queueFull=true when at least one authorized message could not be queued (answer 503 so the
   *          platform redelivers later; already-queued messages are deduplicated by their idempotency key).
   */
  intake(source: Source, messages: NormalizedMessage[]): { accepted: number; ignored: number; queueFull: boolean } {
    const { logger, audit, metrics, queue } = this.d;
    const allowlist = this.allowlists.get(source);
    const state = this.platformState.get(source);
    if (state) state.lastWebhookAt = this.now().toISOString();
    let accepted = 0;
    let ignored = 0;
    let queueFull = false;
    for (const m of messages) {
      if (this.paused[source]) {
        ignored++;
        metrics.inc("messages_ignored_total", { source, reason: "paused" });
        audit.record("platform_paused_message_ignored", { source });
        continue;
      }
      const decision = allowlist ? allowlist.decide(m) : ({ allowed: false, reason: "group_not_allowlisted" } as const);
      if (!decision.allowed) {
        ignored++;
        metrics.inc("messages_ignored_total", { source, reason: decision.reason });
        // Nothing of the message is kept: only the fact, the reason and hashed ids for troubleshooting.
        audit.record(decision.reason === "group_capture_unsupported" ? "unsupported_conversation_ignored" : "unauthorized_conversation_ignored", {
          source, reason: decision.reason, conversationType: m.conversationType, groupRef: logger.ref(m.groupId), senderRef: logger.ref(m.senderId),
        });
        continue;
      }
      const msg: NormalizedMessage = { ...m, groupName: decision.label ?? m.groupName };
      const key = idempotencyKey(msg);
      const result = queue.enqueue(key, msg, this.now());
      if (result === "full") {
        queueFull = true;
        audit.record("queue_full", { source, pending: queue.stats().pending });
        continue;
      }
      if (result !== "queued") {
        logger.debug("intake.redelivery_skipped", { source, result });
        continue;
      }
      accepted++;
      metrics.inc("messages_received_total", { source });
      audit.record("authorized_message_received", {
        source, conversationType: msg.conversationType, messageType: msg.messageType, groupRef: logger.ref(msg.groupId), hasMedia: Boolean(msg.media),
      });
      logger.debug("intake.message", { source, text: logger.content(msg.messageText) });
      if (msg.media) {
        metrics.inc("media_detected_total", { source, kind: msg.media.kind });
        audit.record("media_detected", { source, kind: msg.media.kind, available: msg.media.available });
      }
    }
    if (accepted) this.kick();
    return { accepted, ignored, queueFull };
  }

  // ---- worker ---------------------------------------------------------------------------------------

  start(): void {
    this.stopping = false;
    this.kick();
  }

  /** Stops picking new jobs and waits for running ones to reach a persisted state. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.running.values()]);
  }

  kick(): void {
    if (this.stopping) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), 0);
  }

  /** Runs due jobs up to the concurrency limit, then sleeps until the next one is due (max 5 s). */
  private tick(): void {
    this.timer = null;
    if (this.stopping) return;
    const free = this.d.config.queue.concurrency - this.running.size;
    if (free > 0) {
      for (const job of this.d.queue.due(this.now(), new Set(this.running.keys())).slice(0, free)) {
        const p = this.process(job).finally(() => {
          this.running.delete(job.id);
          this.kick();
        });
        this.running.set(job.id, p);
      }
    }
    const next = this.d.queue.nextDueAt();
    const wait = next ? Math.min(5_000, Math.max(50, Date.parse(next) - this.now().getTime())) : 5_000;
    this.timer = setTimeout(() => this.tick(), wait);
    this.timer.unref();
  }

  /** Processes one job through its remaining stages. Never throws. */
  async process(job: Job): Promise<void> {
    const { queue, logger, audit, config } = this.d;
    try {
      for (let guard = 0; guard < 5; guard++) {
        const state = job.stage === "download" ? await this.download(job) : job.stage === "upload" ? await this.upload(job) : await this.register(job);
        if (state === "done" || state === "deferred") return;
      }
    } catch (raw) {
      const err = raw instanceof TransientError || raw instanceof PermanentError ? raw : classifyBackendError(raw);
      job.lastError = { code: err.code, message: err.message.slice(0, 300), at: this.now().toISOString() };
      if (err instanceof PermanentError) {
        if (err.code === "platform_paused") {
          audit.record("platform_paused_message_ignored", { source: job.message.source, stage: job.stage });
          queue.fail(job, true);
          return;
        }
        logger.warn("job.failed_permanently", { jobId: job.id, stage: job.stage, code: err.code, status: err.status });
        audit.record("job_failed_permanently", { source: job.message.source, stage: job.stage, code: err.code });
        if (job.stage === "register") audit.record("backend_registration_failed", { source: job.message.source, code: err.code });
        queue.fail(job);
        return;
      }
      job.attempts++;
      if (job.attempts >= config.queue.maxAttempts) {
        if (job.stage === "download") {
          // The text report is never lost because a file could not be fetched: register without the file.
          job.outcome = this.outcome(job, "media_unavailable", `download failed after ${job.attempts} attempts (${err.code})`);
          job.stage = "register";
          job.attempts = 0;
          job.nextAttemptAt = this.now().toISOString();
          queue.save(job);
          this.d.metrics.inc("media_unavailable_total", { source: job.message.source });
          return;
        }
        logger.error("job.retries_exhausted", { jobId: job.id, stage: job.stage, code: err.code });
        audit.record("job_failed_permanently", { source: job.message.source, stage: job.stage, code: err.code, attempts: job.attempts });
        queue.fail(job);
        return;
      }
      const delay = backoffDelay(job.attempts, config.queue.baseDelayMs, config.queue.maxDelayMs, this.d.random);
      job.nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
      queue.save(job);
      logger.info("job.retry_scheduled", { jobId: job.id, stage: job.stage, code: err.code, attempt: job.attempts, delayMs: delay });
    }
  }

  private outcome(job: Job, status: MediaOutcome["status"], reason: string | null): MediaOutcome {
    const m = job.message.media!;
    return {
      status, kind: m.kind, reason, fileName: originalFileName(m.filename), mimeType: m.mimeType, fileSizeBytes: m.size, sha256: null, objectKey: null,
    };
  }

  /** Stage 1: get the original file onto local disk, validated — or decide the true outcome without it. */
  private async download(job: Job): Promise<"next" | "deferred"> {
    const { queue, config, audit, metrics, logger } = this.d;
    const m = job.message.media;
    const source = job.message.source;
    const advance = (outcome: MediaOutcome | null) => {
      job.outcome = outcome;
      job.stage = outcome && (outcome.status === "stored" || outcome.status === "duplicate") ? "upload" : "register";
      if (job.file) job.stage = "upload";
      job.attempts = 0;
      queue.save(job);
      return "next" as const;
    };
    if (!m) return advance(null);
    if (m.kind === "audio" || m.kind === "sticker") return advance(this.outcome(job, "not_collected", `${m.kind}_not_in_scope`));
    if (!m.available || !COLLECTED_KINDS.has(m.kind)) {
      metrics.inc("media_unavailable_total", { source });
      audit.record("media_unavailable", { source, kind: m.kind });
      return advance(this.outcome(job, "media_unavailable", m.unavailableReason ?? "Platform API does not expose downloadable attachment"));
    }
    const limit = sizeLimitFor(m.kind, config.limits);
    const reject = (reason: string) => {
      metrics.inc("media_rejected_total", { source, reason });
      audit.record(reason === "size_limit_exceeded" ? "size_limit_exceeded" : "file_rejected", { source, kind: m.kind, reason });
      return advance(this.outcome(job, "rejected", reason));
    };
    if (m.size !== null && m.size > limit) return reject("size_limit_exceeded");
    if (!queue.hasRoomFor(m.size ?? limit)) {
      // Disk budget in use by queued files (e.g. backend down): wait without spending an attempt.
      job.nextAttemptAt = new Date(this.now().getTime() + DISK_WAIT_MS).toISOString();
      queue.save(job);
      logger.warn("job.waiting_for_disk_budget", { jobId: job.id });
      return "deferred";
    }

    const adapter = this.adapters.get(source);
    if (!adapter) throw new PermanentError(`no adapter for ${source}`, "no_adapter");
    let dl;
    try {
      dl = await adapter.fetchMedia(m, AbortSignal.timeout(config.limits.downloadTimeoutMs));
    } catch (err) {
      if (err instanceof PermanentError) {
        metrics.inc("media_unavailable_total", { source });
        audit.record("media_unavailable", { source, kind: m.kind, code: err.code });
        return advance(this.outcome(job, "media_unavailable", `platform did not provide the file (${err.code})`));
      }
      throw err;
    }
    // Download cap: the declared kind's limit (validation re-checks the limit of the DETECTED type).
    const cap = Math.min(limit, maxAnyBytes(config.limits));
    if (dl.declaredSize !== null && dl.declaredSize > cap) {
      await dl.response.body?.cancel().catch(() => undefined);
      return reject("size_limit_exceeded");
    }
    if (!dl.response.body) throw new TransientError("empty download body", "empty_body");
    const path = queue.newMediaPath(job);
    const limiter = new HashingLimiter(cap);
    try {
      await pipeline(Readable.fromWeb(dl.response.body as unknown as WebReadableStream<Uint8Array>), limiter, createWriteStream(path, { mode: 0o600 }));
    } catch (err) {
      rmSync(path, { force: true });
      if (err instanceof SizeLimitError) return reject("size_limit_exceeded");
      throw new TransientError(`download interrupted: ${(err as Error).message}`, (err as Error).name === "TimeoutError" ? "timeout" : "download_interrupted");
    }
    const size = limiter.bytes;
    const sha256 = limiter.digest();
    if (dl.declaredSize !== null && dl.declaredSize !== size) {
      rmSync(path, { force: true });
      throw new TransientError(`incomplete download (${size} of ${dl.declaredSize} bytes)`, "incomplete_download");
    }
    if (matchesDeclaredSha256(sha256, dl.declaredSha256) === false) {
      rmSync(path, { force: true });
      throw new TransientError("checksum does not match the platform's", "checksum_mismatch");
    }
    const fileName = originalFileName(m.filename);
    const v = await validateFile({ path, size, declaredMime: dl.declaredMime ?? m.mimeType, fileName, limits: config.limits });
    if (!v.ok) {
      rmSync(path, { force: true });
      logger.info("file.rejected", { jobId: job.id, reason: v.reason, detail: v.detail });
      return reject(v.reason);
    }
    job.file = { path, size, sha256, detected: v.detected, originalFileName: fileName };
    return advance(null);
  }

  /** Stage 2: put the original bytes in R2 (unless the backend already has the same bytes). */
  private async upload(job: Job): Promise<"next" | "done"> {
    const { queue, backend, r2, audit, metrics } = this.d;
    const f = job.file;
    if (!f || !existsSync(f.path)) {
      job.file = null;
      job.stage = "download";
      queue.save(job);
      return "next";
    }
    const source = job.message.source;
    const res = await this.backendCall(() =>
      backend.uploadUrl(
        {
          source, platformMessageId: job.message.platformMessageId, platformMediaId: job.message.media?.platformMediaId ?? null,
          sha256: f.sha256, fileSizeBytes: f.size, mimeType: f.detected.mime, mediaKind: f.detected.kind, fileName: f.originalFileName,
          receivedAt: job.message.receivedAt,
        },
        job.key,
      ),
    );
    const outcome = (status: "stored" | "duplicate", objectKey: string): MediaOutcome => ({
      status, kind: f.detected.kind, reason: null, fileName: f.originalFileName, mimeType: f.detected.mime, fileSizeBytes: f.size, sha256: f.sha256, objectKey,
    });
    if (res.status === "already_registered") {
      queue.complete(job);
      return "done";
    }
    if (res.status === "duplicate") {
      metrics.inc("media_duplicate_total", { source });
      audit.record("media_duplicate", { source, kind: f.detected.kind });
      job.outcome = outcome("duplicate", res.objectKey);
    } else {
      try {
        await r2.put(f.path, f.size, res.uploadUrl, res.headers);
      } catch (err) {
        metrics.inc("upload_failures_total", { source });
        metrics.inc("r2_errors_total", {});
        this.r2State.lastUploadOk = false;
        this.r2State.lastError = (err as Error).message.slice(0, 200);
        throw err;
      }
      this.r2State.lastUploadOk = true;
      this.r2State.lastUploadAt = this.now().toISOString();
      this.r2State.lastError = null;
      metrics.inc("media_uploaded_total", { source, kind: f.detected.kind });
      audit.record("media_uploaded", { source, kind: f.detected.kind, bytes: f.size, sha256: f.sha256 });
      job.outcome = outcome("stored", res.objectKey);
    }
    job.stage = "register";
    job.attempts = 0;
    queue.save(job);
    return "next";
  }

  /** Stage 3: register the message and the true media outcome with the backend. */
  private async register(job: Job): Promise<"next" | "done"> {
    const { queue, backend, audit, metrics } = this.d;
    try {
      const res = await this.backendCall(() => backend.register(job.message, job.outcome, job.key));
      metrics.inc("registrations_total", { source: job.message.source, mediaStatus: job.outcome?.status ?? "none" });
      audit.record("backend_registration_succeeded", {
        source: job.message.source, mediaStatus: res.mediaStatus, duplicate: res.status === "duplicate", androidDuplicate: Boolean(res.duplicateOfMessageId),
      });
      queue.complete(job);
      return "done";
    } catch (err) {
      // The backend could not confirm the object in R2 (expired URL, lost upload): upload again.
      if (err instanceof BackendError && err.status === 409 && (err.code === "upload_not_verified" || err.code === "upload_not_issued") && job.file) {
        job.stage = "upload";
        job.outcome = null;
        queue.save(job);
        throw new TransientError(err.message, err.code, 409);
      }
      throw err;
    }
  }

  /** Backend call with connection-state tracking and error classification. */
  private async backendCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      this.backendState.status = "connected";
      this.backendState.lastSuccessAt = this.now().toISOString();
      this.backendState.lastError = null;
      return out;
    } catch (err) {
      this.d.metrics.inc("backend_errors_total", {});
      if (err instanceof BackendError) {
        if (err.status === 401) {
          this.backendState.status = "auth_error";
          this.d.audit.record("backend_auth_failed", {});
        } else if (err.status === 423) {
          throw new PermanentError(err.message, "platform_paused", 423);
        } else if (err.status === 409) {
          this.backendState.status = "connected";
          throw err; // handled by register()
        } else {
          this.backendState.status = err.status >= 500 ? "error" : "connected";
        }
      } else {
        this.backendState.status = "unreachable";
      }
      this.backendState.lastError = (err as Error).message.slice(0, 200);
      throw classifyBackendError(err);
    }
  }

  // ---- heartbeat / probes ---------------------------------------------------------------------------

  async heartbeat(snapshot: unknown): Promise<void> {
    try {
      const res = await this.backendCall(() => this.d.backend.heartbeat(snapshot));
      for (const s of ["whatsapp", "viber"] as const) {
        const next = s === "whatsapp" ? res.settings.whatsappPaused === true : res.settings.viberPaused === true;
        if (next !== this.paused[s]) {
          this.d.audit.record(next ? "platform_disconnected" : "platform_connected", { source: s, reason: next ? "paused_in_command_center" : "resumed_in_command_center" });
        }
        this.paused[s] = next;
      }
    } catch (err) {
      this.d.logger.warn("heartbeat.failed", { error: (err as Error).message });
    }
    try {
      this.backendState.media = (await this.d.backend.health()).media ?? null;
    } catch {
      /* reflected in backendState by the heartbeat */
    }
  }

  async probePlatforms(): Promise<void> {
    for (const a of this.adapters.values()) {
      const state = this.platformState.get(a.source)!;
      const before = state.probe?.status ?? null;
      const probe = await a.probe();
      state.probe = probe;
      if (probe.status !== before && a.enabled) {
        if (probe.status === "connected") this.d.audit.record("platform_connected", { source: a.source });
        else if (probe.status === "auth_error") this.d.audit.record("platform_auth_failed", { source: a.source });
        else if (before === "connected") this.d.audit.record("platform_disconnected", { source: a.source, status: probe.status });
      }
    }
  }

  adapterFor(source: Source): MediaSourceAdapter | undefined {
    return this.adapters.get(source);
  }

  allowlistCounts(source: Source): { groups: number; senders: number } {
    return this.allowlists.get(source)?.counts ?? { groups: 0, senders: 0 };
  }
}
