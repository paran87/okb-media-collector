/**
 * Error classification and backoff. Transient failures (network, timeouts, 5xx, 429, auth problems an operator
 * can fix) are retried with exponential backoff up to RETRY_MAX_ATTEMPTS; permanent failures (validation, other
 * 4xx) are not retried.
 */

export class TransientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "TransientError";
  }
}

export class PermanentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "PermanentError";
  }
}

/** HTTP status -> transient? (408 timeout, 425, 429 rate limit, 5xx; 401/403 = credentials, fixable by an operator) */
export function isTransientStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

export function classifyNetworkError(err: unknown, what: string): TransientError {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  const code = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : e?.cause?.code || e?.code || "network_error";
  return new TransientError(`${what}: ${code}`, String(code));
}

export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + random() * 0.4;
  return Math.round(Math.min(maxMs, exp * jitter));
}
