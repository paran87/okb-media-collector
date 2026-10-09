import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { MediaOutcome, NormalizedMessage } from "../model/message";
import type { DetectedType } from "../security/validation";

/**
 * Durable, bounded work queue on the local disk.
 *
 *   DATA_DIR/queue/pending/<id>.json   jobs waiting or retrying (one file per job, written atomically)
 *   DATA_DIR/queue/failed/<id>.json    jobs that exhausted their retries or failed permanently (kept for an operator)
 *   DATA_DIR/media/<id>.bin            downloaded original files waiting for upload
 *   DATA_DIR/queue/done.log            idempotency keys of completed jobs (bounded), so platform redeliveries are skipped
 *
 * A job survives restarts at the stage it reached (download -> upload -> register). The queue refuses new jobs
 * when it holds QUEUE_MAX_ITEMS jobs, and downloads wait while staged files use QUEUE_MAX_DISK_MB, so a backend or
 * R2 outage can never exhaust the disk. Webhooks answer 503 while the queue is full, so the platform retries the
 * delivery later instead of the report being lost.
 */

export type Stage = "download" | "upload" | "register";

export interface StagedFile {
  path: string;
  size: number;
  sha256: string;
  detected: DetectedType;
  originalFileName: string | null;
}

export interface Job {
  id: string;
  key: string;
  createdAt: string;
  updatedAt: string;
  stage: Stage;
  attempts: number;
  nextAttemptAt: string;
  message: NormalizedMessage;
  file: StagedFile | null;
  outcome: MediaOutcome | null;
  lastError: { code: string; message: string; at: string } | null;
}

export type EnqueueResult = "queued" | "duplicate" | "already_done" | "full";

const DONE_KEEP = 20_000;

export class PersistentQueue {
  readonly pendingDir: string;
  readonly failedDir: string;
  readonly mediaDir: string;
  private readonly doneFile: string;
  private readonly jobs = new Map<string, Job>();
  private readonly keys = new Map<string, string>();
  private done = new Set<string>();
  private doneLines = 0;
  private failedCount = 0;

  constructor(
    dataDir: string,
    private readonly maxItems: number,
    private readonly maxDiskBytes: number,
  ) {
    this.pendingDir = join(dataDir, "queue", "pending");
    this.failedDir = join(dataDir, "queue", "failed");
    this.mediaDir = join(dataDir, "media");
    this.doneFile = join(dataDir, "queue", "done.log");
    for (const d of [this.pendingDir, this.failedDir, this.mediaDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  /** Loads pending jobs after a restart and removes staged files that no job references. */
  load(): { recovered: number; orphansRemoved: number } {
    for (const name of readdirSync(this.pendingDir)) {
      if (!name.endsWith(".json")) {
        rmSync(join(this.pendingDir, name), { force: true }); // interrupted atomic write
        continue;
      }
      try {
        const job = JSON.parse(readFileSync(join(this.pendingDir, name), "utf8")) as Job;
        if (job.file && !existsSync(job.file.path)) {
          // The staged file is gone (disk wiped): download again.
          job.file = null;
          job.stage = "download";
          job.outcome = null;
        }
        this.jobs.set(job.id, job);
        this.keys.set(job.key, job.id);
      } catch {
        renameSync(join(this.pendingDir, name), join(this.failedDir, `corrupt-${name}`));
      }
    }
    this.failedCount = readdirSync(this.failedDir).filter((n) => n.endsWith(".json")).length;
    const referenced = new Set<string>();
    for (const j of this.jobs.values()) if (j.file) referenced.add(j.file.path);
    for (const name of readdirSync(this.failedDir)) {
      try {
        const j = JSON.parse(readFileSync(join(this.failedDir, name), "utf8")) as Job;
        if (j.file) referenced.add(j.file.path);
      } catch {
        /* corrupt entries keep nothing alive */
      }
    }
    let orphansRemoved = 0;
    for (const name of readdirSync(this.mediaDir)) {
      const p = join(this.mediaDir, name);
      if (!referenced.has(p)) {
        rmSync(p, { force: true });
        orphansRemoved++;
      }
    }
    if (existsSync(this.doneFile)) {
      const lines = readFileSync(this.doneFile, "utf8").split("\n").filter(Boolean);
      this.done = new Set(lines.slice(-DONE_KEEP));
      this.doneLines = lines.length;
    }
    return { recovered: this.jobs.size, orphansRemoved };
  }

  private write(dir: string, job: Job): void {
    const final = join(dir, `${job.id}.json`);
    const tmp = join(dir, `.${job.id}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
    renameSync(tmp, final);
  }

  isDone(key: string): boolean {
    return this.done.has(key);
  }

  enqueue(key: string, message: NormalizedMessage, now = new Date()): EnqueueResult {
    if (this.done.has(key)) return "already_done";
    if (this.keys.has(key)) return "duplicate";
    if (this.jobs.size >= this.maxItems) return "full";
    const at = now.toISOString();
    const job: Job = {
      id: randomUUID(), key, createdAt: at, updatedAt: at, stage: "download", attempts: 0, nextAttemptAt: at,
      message, file: null, outcome: null, lastError: null,
    };
    this.write(this.pendingDir, job);
    this.jobs.set(job.id, job);
    this.keys.set(key, job.id);
    return "queued";
  }

  /** Persists a job's progress (stage, staged file, outcome, attempts). */
  save(job: Job): void {
    job.updatedAt = new Date().toISOString();
    this.write(this.pendingDir, job);
    this.jobs.set(job.id, job);
  }

  /** Jobs due now, oldest first (a restart keeps the original order). */
  due(now = new Date(), exclude: Set<string> = new Set()): Job[] {
    const t = now.toISOString();
    return [...this.jobs.values()]
      .filter((j) => j.nextAttemptAt <= t && !exclude.has(j.id))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  nextDueAt(): string | null {
    let min: string | null = null;
    for (const j of this.jobs.values()) if (min === null || j.nextAttemptAt < min) min = j.nextAttemptAt;
    return min;
  }

  complete(job: Job): void {
    if (job.file) rmSync(job.file.path, { force: true });
    rmSync(join(this.pendingDir, `${job.id}.json`), { force: true });
    this.jobs.delete(job.id);
    this.keys.delete(job.key);
    this.done.add(job.key);
    appendFileSync(this.doneFile, `${job.key}\n`, { mode: 0o600 });
    this.doneLines++;
    if (this.doneLines > DONE_KEEP * 2) {
      const keep = [...this.done].slice(-DONE_KEEP);
      this.done = new Set(keep);
      writeFileSync(`${this.doneFile}.tmp`, `${keep.join("\n")}\n`, { mode: 0o600 });
      renameSync(`${this.doneFile}.tmp`, this.doneFile);
      this.doneLines = keep.length;
    }
  }

  /**
   * Moves a job to failed/. Its staged file is kept (an operator can retry it) unless `dropFile`; the oldest
   * failed jobs' files are removed when staged files exceed the disk budget.
   */
  fail(job: Job, dropFile = false): void {
    if (dropFile && job.file) {
      rmSync(job.file.path, { force: true });
      job.file = null;
    }
    job.updatedAt = new Date().toISOString();
    this.write(this.failedDir, job);
    rmSync(join(this.pendingDir, `${job.id}.json`), { force: true });
    this.jobs.delete(job.id);
    this.keys.delete(job.key);
    this.failedCount++;
    this.enforceDiskBudget();
  }

  /** Puts every failed job back into pending (operator action). */
  retryFailed(now = new Date()): number {
    let n = 0;
    for (const name of readdirSync(this.failedDir)) {
      if (!name.endsWith(".json") || name.startsWith("corrupt-")) continue;
      const p = join(this.failedDir, name);
      const job = JSON.parse(readFileSync(p, "utf8")) as Job;
      if (this.keys.has(job.key) || this.done.has(job.key)) {
        rmSync(p, { force: true });
        continue;
      }
      if (this.jobs.size >= this.maxItems) break;
      if (job.file && !existsSync(job.file.path)) {
        job.file = null;
        job.stage = "download";
        job.outcome = null;
      }
      job.attempts = 0;
      job.nextAttemptAt = now.toISOString();
      this.write(this.pendingDir, job);
      rmSync(p, { force: true });
      this.jobs.set(job.id, job);
      this.keys.set(job.key, job.id);
      n++;
    }
    this.failedCount = readdirSync(this.failedDir).filter((x) => x.endsWith(".json")).length;
    return n;
  }

  diskUsage(): number {
    let total = 0;
    for (const name of readdirSync(this.mediaDir)) {
      try {
        total += statSync(join(this.mediaDir, name)).size;
      } catch {
        /* removed meanwhile */
      }
    }
    return total;
  }

  /** True when `bytes` more can be staged within the disk budget. */
  hasRoomFor(bytes: number): boolean {
    return this.diskUsage() + bytes <= this.maxDiskBytes;
  }

  newMediaPath(job: Job): string {
    return join(this.mediaDir, `${job.id}.bin`);
  }

  private enforceDiskBudget(): void {
    if (this.diskUsage() <= this.maxDiskBytes) return;
    const failed = readdirSync(this.failedDir)
      .filter((n) => n.endsWith(".json") && !n.startsWith("corrupt-"))
      .map((n) => ({ n, t: statSync(join(this.failedDir, n)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const { n } of failed) {
      const p = join(this.failedDir, n);
      const job = JSON.parse(readFileSync(p, "utf8")) as Job;
      if (job.file) {
        rmSync(job.file.path, { force: true });
        job.file = null;
        job.stage = "download";
        job.outcome = null;
        writeFileSync(p, JSON.stringify(job), { mode: 0o600 });
      }
      if (this.diskUsage() <= this.maxDiskBytes) return;
    }
  }

  stats(): { pending: number; failed: number; diskBytes: number } {
    return { pending: this.jobs.size, failed: this.failedCount, diskBytes: this.diskUsage() };
  }
}
