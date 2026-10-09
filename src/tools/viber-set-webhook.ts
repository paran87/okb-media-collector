/**
 * Registers (or removes) the collector's webhook with the Viber Bot API. Viber calls the URL once to verify it
 * (signed "webhook" event; the running collector answers 200), so start the collector first.
 *
 *   node dist/src/tools/viber-set-webhook.js https://collector.example.org/webhooks/viber
 *   node dist/src/tools/viber-set-webhook.js --remove
 *
 * Reads VIBER_AUTH_TOKEN (and optional VIBER_API_BASE_URL) from the environment; the token is never printed.
 */
async function main(): Promise<void> {
  const token = process.env.VIBER_AUTH_TOKEN?.trim();
  const base = (process.env.VIBER_API_BASE_URL?.trim() || "https://chatapi.viber.com/pa").replace(/\/+$/, "");
  const arg = process.argv[2];
  if (!token || !arg) {
    process.stderr.write("usage: VIBER_AUTH_TOKEN=… node dist/src/tools/viber-set-webhook.js <https URL>|--remove\n");
    process.exit(2);
  }
  const remove = arg === "--remove";
  if (!remove && !/^https:\/\/[^\s]+\/webhooks\/viber$/.test(arg)) {
    process.stderr.write("the webhook URL must be https and end with /webhooks/viber\n");
    process.exit(2);
  }
  const body = remove
    ? { url: "" }
    : { url: arg, event_types: ["delivered", "seen", "failed", "subscribed", "unsubscribed", "conversation_started"], send_name: true, send_photo: false };
  const res = await fetch(`${base}/set_webhook`, {
    method: "POST",
    headers: { "X-Viber-Auth-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const out = (await res.json().catch(() => ({}))) as { status?: number; status_message?: string };
  process.stdout.write(`${JSON.stringify({ httpStatus: res.status, status: out.status, statusMessage: out.status_message })}\n`);
  process.exit(out.status === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
