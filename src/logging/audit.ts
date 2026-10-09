import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger";

/**
 * Audit trail of security- and operations-relevant events. Each event goes to the structured log (event name
 * "audit.<event>") and to a daily JSONL file under DATA_DIR/audit (kept for `retainDays`).
 *
 * Audit entries carry ids as salted hashes and never contain message text, tokens, cookies, signatures or URLs.
 */

export type AuditEvent =
  | "collector_started"
  | "collector_stopped"
  | "platform_connected"
  | "platform_disconnected"
  | "platform_auth_failed"
  | "webhook_signature_invalid"
  | "authorized_message_received"
  | "unauthorized_conversation_ignored"
  | "platform_paused_message_ignored"
  | "unsupported_conversation_ignored"
  | "media_detected"
  | "media_unavailable"
  | "media_uploaded"
  | "media_duplicate"
  | "file_rejected"
  | "size_limit_exceeded"
  | "backend_registration_succeeded"
  | "backend_registration_failed"
  | "backend_auth_failed"
  | "queue_full"
  | "job_failed_permanently";

export interface Audit {
  record(event: AuditEvent, fields?: Record<string, unknown>): void;
}

export function createAudit(logger: Logger, dir: string | null, retainDays = 30): Audit {
  if (dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    prune(dir, retainDays);
  }
  let lastPrune = Date.now();
  return {
    record(event, fields = {}) {
      logger.info(`audit.${event}`, fields);
      if (!dir) return;
      const at = new Date();
      const file = join(dir, `audit-${at.toISOString().slice(0, 10)}.jsonl`);
      try {
        // Same scrubbing as the logger: serialize through it by building a minimal record.
        const safe: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) {
          if (/(token|secret|authorization|password|cookie|signature|url|text)/i.test(k)) continue;
          safe[k] = v;
        }
        appendFileSync(file, `${JSON.stringify({ at: at.toISOString(), event, ...safe })}\n`, { mode: 0o600 });
      } catch (err) {
        logger.warn("audit.write_failed", { error: err });
      }
      if (Date.now() - lastPrune > 6 * 3600_000) {
        lastPrune = Date.now();
        prune(dir, retainDays);
      }
    },
  };
}

function prune(dir: string, retainDays: number): void {
  const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString().slice(0, 10);
  try {
    for (const name of readdirSync(dir)) {
      const m = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (m && m[1]! < cutoff) unlinkSync(join(dir, name));
    }
  } catch {
    /* best effort */
  }
}
