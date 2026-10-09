/**
 * In-process counters and gauges, exposed as Prometheus text on GET /metrics. Labels are limited to the source
 * platform and fixed reason codes: never group ids, sender ids or message content.
 */

export type Counter =
  | "messages_received_total"
  | "messages_ignored_total"
  | "media_detected_total"
  | "media_uploaded_total"
  | "media_duplicate_total"
  | "media_unavailable_total"
  | "media_rejected_total"
  | "upload_failures_total"
  | "r2_errors_total"
  | "backend_errors_total"
  | "registrations_total"
  | "webhook_signature_failures_total";

const HELP: Record<Counter, string> = {
  messages_received_total: "Messages from authorized conversations accepted into the queue",
  messages_ignored_total: "Messages ignored (unauthorized conversation, paused platform, unsupported)",
  media_detected_total: "Messages that carried media",
  media_uploaded_total: "Original files uploaded to R2",
  media_duplicate_total: "Files whose bytes were already in R2 (not uploaded again)",
  media_unavailable_total: "Media the platform did not provide",
  media_rejected_total: "Files rejected by validation",
  upload_failures_total: "Failed R2 upload attempts",
  r2_errors_total: "R2 errors (upload or presign)",
  backend_errors_total: "OKB backend request failures",
  registrations_total: "Messages registered with the OKB backend",
  webhook_signature_failures_total: "Webhook requests with a missing or invalid signature",
};

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, () => number>();

  inc(name: Counter, labels: Record<string, string> = {}, by = 1): void {
    const key = `${name}${formatLabels(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  get(name: Counter, labels: Record<string, string> = {}): number {
    return this.counters.get(`${name}${formatLabels(labels)}`) ?? 0;
  }

  gauge(name: string, read: () => number): void {
    this.gauges.set(name, read);
  }

  render(): string {
    const lines: string[] = [];
    const byName = new Map<string, string[]>();
    for (const [key, value] of this.counters) {
      const name = key.replace(/\{.*$/, "");
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push(`okb_collector_${key} ${value}`);
    }
    for (const [name, rows] of byName) {
      lines.push(`# HELP okb_collector_${name} ${HELP[name as Counter] ?? name}`, `# TYPE okb_collector_${name} counter`, ...rows);
    }
    for (const [name, read] of this.gauges) {
      let v = 0;
      try {
        v = read();
      } catch {
        v = NaN;
      }
      lines.push(`# TYPE okb_collector_${name} gauge`, `okb_collector_${name} ${v}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return "";
  return `{${keys.map((k) => `${k}="${String(labels[k]).replace(/[\\"\n]/g, "_")}"`).join(",")}}`;
}
