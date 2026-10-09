/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert";
import { createHash } from "node:crypto";
import test from "node:test";
import { SECRETS, VIBER_SENDER, WA_GROUP, WA_OTHER_GROUP, WA_SENDER } from "./helpers/config";
import { allLogText, backendAvailable, environment, waitFor, type Env } from "./helpers/environment";
import * as F from "./helpers/fixtures";
import { viberMessage, viberSigned, waSigned, waWebhook } from "./helpers/payloads";

/**
 * End-to-end: signed webhook -> collector -> real backend code -> R2 stand-in. Numbered tests match
 * docs/TEST-PLAN.md. Platform APIs are local fakes built from the documented payloads: these tests prove the
 * collector's own behaviour, NOT that WhatsApp/Viber deliver group media (that needs a real authorized account).
 */

const skip = backendAvailable ? false : "okb-bridge-cloud-backend not found next to this repository (set OKB_BACKEND_DIR)";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function postWa(env: Env, messages: any[], opts: { group?: string | null; from?: string; secret?: string } = {}) {
  const group = opts.group === undefined ? WA_GROUP : opts.group;
  const body = waWebhook(messages.map((m) => ({ ...(group ? { group_id: group } : {}), ...m })), undefined, opts.from);
  const { raw, headers } = waSigned(body, opts.secret);
  return fetch(`${env.base}/webhooks/whatsapp`, { method: "POST", headers, body: raw });
}

async function postViber(env: Env, message: Record<string, unknown>, sender = VIBER_SENDER) {
  const raw = viberMessage(message, sender);
  return fetch(`${env.base}/webhooks/viber`, { method: "POST", headers: viberSigned(raw), body: raw });
}

const drained = (env: Env) => waitFor(() => env.collector.queue.stats().pending === 0, "queue drained");
const ingestion = (env: Env, platformMessageId: string) => env.backend.ingestions().find((r) => r.platformMessageId === platformMessageId);

function assertNoSecrets(env: Env, dirs?: string[]) {
  const text = allLogText(env, dirs);
  for (const [name, value] of Object.entries(SECRETS)) assert.ok(!text.includes(value), `secret ${name} leaked into logs`);
  assert.ok(!/X-Amz-Signature/i.test(text), "presigned URL leaked into logs");
}

test("TEST 1: authorized WhatsApp group text", { skip }, async () => {
  const env = await environment();
  try {
    const res = await postWa(env, [{ id: "wamid.T1", type: "text", text: { body: "Flood at España Blvd, gutter deep, passable" } }]);
    assert.strictEqual(res.status, 200);
    await drained(env);
    const msg = env.backend.state.messages.find((m) => m.clientMessageId === "wamid.T1");
    assert.ok(msg, "message stored in the backend");
    assert.strictEqual(msg.platform, "whatsapp");
    assert.strictEqual(msg.groupId, WA_GROUP);
    assert.strictEqual(msg.groupName, "OKB NCR Flood Reports");
    assert.strictEqual(msg.senderId, WA_SENDER);
    assert.strictEqual(msg.senderName, "MM3DEO");
    assert.strictEqual(msg.timestamp, "2026-10-09T14:42:00.000Z");
    assert.strictEqual(ingestion(env, "wamid.T1").mediaStatus, "none");
    assert.ok(env.backend.server.okb.reports.forMessage(msg.id), "existing report pipeline received it");
    assertNoSecrets(env);
  } finally {
    await env.close();
  }
});

test("TEST 2: authorized WhatsApp group photo -> original bytes in R2, linked to the report", { skip }, async () => {
  const env = await environment();
  try {
    const photo = F.jpeg(50_000);
    env.platform.files.set("MEDIA-PHOTO", { bytes: photo, mime: "image/jpeg" });
    await postWa(env, [{ id: "wamid.T2", type: "image", image: { id: "MEDIA-PHOTO", mime_type: "image/jpeg", caption: "Taft Ave knee deep" } }]);
    await drained(env);
    const row = ingestion(env, "wamid.T2");
    assert.strictEqual(row.mediaStatus, "stored");
    assert.match(row.r2Key, /^whatsapp\/2026\/10\/09\/[0-9a-f-]{36}-media\.jpg$/);
    const obj = env.r2.objects.get(row.r2Key)!;
    assert.ok(obj, "object in R2");
    assert.strictEqual(sha(obj.bytes), sha(photo), "original bytes unchanged");
    assert.strictEqual(obj.contentType, "image/jpeg");
    assert.strictEqual(Number(obj.contentLength), photo.length, "streamed with an explicit Content-Length");
    assert.strictEqual(row.sha256, sha(photo));
    const report = env.backend.server.okb.reports.get(env.backend.server.okb.reports.forMessage(row.messageId).id);
    assert.strictEqual(report.media.length, 1);
    assert.strictEqual(report.media[0].objectKey, row.r2Key);
    assert.strictEqual(env.collector.metrics.get("media_uploaded_total", { kind: "image", source: "whatsapp" }), 1);
  } finally {
    await env.close();
  }
});

test("TEST 3 + TEST 4: authorized WhatsApp PDF and DOCX keep their original file and name", { skip }, async () => {
  const env = await environment();
  try {
    const pdf = F.pdf();
    const docx = F.docx();
    env.platform.files.set("M-PDF", { bytes: pdf, mime: "application/pdf" });
    env.platform.files.set("M-DOCX", { bytes: docx, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    await postWa(env, [
      { id: "wamid.T3", type: "document", document: { id: "M-PDF", mime_type: "application/pdf", filename: "NCR Flood Report 0900H.pdf" } },
      { id: "wamid.T4", type: "document", document: { id: "M-DOCX", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "Situation Report.docx" } },
    ]);
    await drained(env);
    const p = ingestion(env, "wamid.T3");
    assert.strictEqual(p.mediaStatus, "stored");
    assert.strictEqual(p.originalFileName, "NCR Flood Report 0900H.pdf");
    assert.match(p.r2Key, /-NCR-Flood-Report-0900H\.pdf$/);
    assert.strictEqual(sha(env.r2.objects.get(p.r2Key)!.bytes), sha(pdf));
    const d = ingestion(env, "wamid.T4");
    assert.strictEqual(d.mediaStatus, "stored");
    assert.match(d.r2Key, /\.docx$/);
    assert.strictEqual(d.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  } finally {
    await env.close();
  }
});

test("TEST 5: unauthorized WhatsApp group and sender are ignored: nothing downloaded, stored or forwarded", { skip }, async () => {
  const env = await environment();
  try {
    env.platform.files.set("M-SECRET", { bytes: F.jpeg(), mime: "image/jpeg" });
    const r1 = await postWa(env, [{ id: "wamid.T5a", type: "image", image: { id: "M-SECRET", mime_type: "image/jpeg", caption: "private family photo" } }], { group: WA_OTHER_GROUP });
    const r2 = await postWa(env, [{ id: "wamid.T5b", type: "text", text: { body: "private chat" } }], { group: null, from: "639999999999" });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    await drained(env);
    assert.strictEqual(env.backend.state.messages.length, 0);
    assert.strictEqual(env.backend.ingestions().length, 0);
    assert.strictEqual(env.r2.objects.size, 0);
    assert.ok(!env.platform.requests.some((r) => r.includes("M-SECRET")), "media of an unauthorized group is never downloaded");
    const text = allLogText(env);
    assert.match(text, /unauthorized_conversation_ignored/);
    assert.ok(!text.includes("private family photo") && !text.includes("private chat"), "no content of ignored messages is kept");
    assert.ok(!text.includes(WA_OTHER_GROUP), "group id only as a hash");
  } finally {
    await env.close();
  }
});

test("TEST 6, 7, 8: authorized Viber text, photo and PDF (1:1 with the bot)", { skip }, async () => {
  const env = await environment();
  try {
    const photo = F.jpeg(20_000);
    const pdf = F.pdf("viber");
    env.platform.files.set("v-photo", { bytes: photo, mime: "image/jpeg" });
    env.platform.files.set("v-pdf", { bytes: pdf, mime: "application/octet-stream" });
    assert.strictEqual((await postViber(env, { type: "text", text: "Flood at Quiapo underpass, 2 ft" })).status, 200);
    await postViber(env, { type: "picture", text: "", media: env.platform.viberUrl("v-photo") });
    await postViber(env, { type: "file", media: env.platform.viberUrl("v-pdf"), file_name: "report.pdf", file_size: pdf.length });
    await drained(env);
    const rows = env.backend.ingestions().filter((r) => r.source === "viber");
    assert.strictEqual(rows.length, 3);
    for (const r of rows) {
      assert.strictEqual(r.conversationType, "direct");
      assert.strictEqual(r.senderId, VIBER_SENDER);
      assert.match(r.platformMessageId, /^\d{19}$/, "64-bit message token preserved");
    }
    assert.deepStrictEqual(rows.map((r) => r.mediaStatus).sort(), ["none", "stored", "stored"]);
    assert.ok([...env.r2.objects.keys()].every((k) => k.startsWith("viber/2026/10/09/")));
  } finally {
    await env.close();
  }
});

test("Viber group traffic and VIBER_ALLOWED_GROUP_IDS: reported as VIBER_MEDIA_CAPTURE_UNSUPPORTED", { skip }, async () => {
  const env = await environment();
  try {
    const health = (await (await fetch(`${env.base}/health`)).json()) as any;
    assert.deepStrictEqual(health.viber.groupCapture, { status: "unsupported", code: "VIBER_MEDIA_CAPTURE_UNSUPPORTED" });
    // A sender that is not allowlisted (the only way a Viber message can reach the bot) is ignored.
    await postViber(env, { type: "text", text: "hello" }, "someone-else=");
    await drained(env);
    assert.strictEqual(env.backend.ingestions().length, 0);
  } finally {
    await env.close();
  }
});

test("TEST 9: duplicate media and webhook redelivery: one R2 object, one registration per message", { skip }, async () => {
  const env = await environment();
  try {
    const photo = F.jpeg(30_000);
    env.platform.files.set("DUP-1", { bytes: photo, mime: "image/jpeg" });
    env.platform.files.set("DUP-2", { bytes: photo, mime: "image/jpeg" });
    const msg = { id: "wamid.T9a", type: "image", image: { id: "DUP-1", mime_type: "image/jpeg" } };
    await postWa(env, [msg]);
    await drained(env);
    await postWa(env, [msg]); // platform redelivers the same webhook
    await postWa(env, [{ id: "wamid.T9b", type: "image", image: { id: "DUP-2", mime_type: "image/jpeg" } }]); // same bytes, other message
    await drained(env);
    assert.strictEqual(env.r2.objects.size, 1, "the same bytes are stored once");
    assert.strictEqual(env.backend.ingestions().length, 2);
    assert.strictEqual(ingestion(env, "wamid.T9b").mediaStatus, "duplicate");
    assert.strictEqual(ingestion(env, "wamid.T9b").r2Key, ingestion(env, "wamid.T9a").r2Key);
    assert.strictEqual(env.platform.requests.filter((r) => r.includes("/wa-files/DUP-1")).length, 1, "redelivery does not download again");
  } finally {
    await env.close();
  }
});

test("TEST 10: R2 failure is retried and then succeeds", { skip }, async () => {
  const env = await environment();
  try {
    env.r2.failNextPuts(2);
    env.platform.files.set("R2F", { bytes: F.jpeg(), mime: "image/jpeg" });
    await postWa(env, [{ id: "wamid.T10", type: "image", image: { id: "R2F", mime_type: "image/jpeg" } }]);
    await drained(env);
    assert.strictEqual(ingestion(env, "wamid.T10").mediaStatus, "stored");
    assert.strictEqual(env.collector.metrics.get("upload_failures_total", { source: "whatsapp" }), 2);
    assert.strictEqual(env.r2.objects.size, 1);
  } finally {
    await env.close();
  }
});

test("expired presigned upload URL (R2 answers 403): a new URL is requested and the upload succeeds", { skip }, async () => {
  const env = await environment();
  try {
    env.r2.failNextPuts(1, 403);
    env.platform.files.set("EXPURL", { bytes: F.jpeg(), mime: "image/jpeg" });
    await postWa(env, [{ id: "wamid.EXPURL", type: "image", image: { id: "EXPURL", mime_type: "image/jpeg" } }]);
    await drained(env);
    const row = ingestion(env, "wamid.EXPURL");
    assert.strictEqual(row.mediaStatus, "stored");
    assert.strictEqual(env.r2.objects.size, 1);
    assert.strictEqual(env.collector.metrics.get("upload_failures_total", { source: "whatsapp" }), 1);
  } finally {
    await env.close();
  }
});

test("TEST 11: backend unavailable -> queued and retried, nothing lost", { skip }, async () => {
  const env = await environment((c) => {
    c.queue.maxAttempts = 50;
  });
  try {
    env.proxy.setDown(true);
    env.platform.files.set("BF", { bytes: F.pdf(), mime: "application/pdf" });
    const res = await postWa(env, [{ id: "wamid.T11", type: "document", document: { id: "BF", mime_type: "application/pdf", filename: "r.pdf" } }]);
    assert.strictEqual(res.status, 200, "the webhook is acknowledged once the job is on disk");
    await waitFor(() => env.collector.metrics.get("backend_errors_total") >= 2, "backend errors");
    assert.strictEqual(env.collector.queue.stats().pending, 1);
    assert.strictEqual(((await (await fetch(`${env.base}/health`)).json()) as any).okbBackend.status, "error");
    env.proxy.setDown(false);
    await drained(env);
    assert.strictEqual(ingestion(env, "wamid.T11").mediaStatus, "stored");
  } finally {
    await env.close();
  }
});

test("TEST 12: restart while the queue holds pending files -> resumed after restart", { skip }, async () => {
  const env = await environment((c) => {
    c.queue.maxAttempts = 50;
  });
  try {
    env.proxy.setDown(true);
    env.platform.files.set("RS", { bytes: F.jpeg(), mime: "image/jpeg" });
    await postWa(env, [{ id: "wamid.T12", type: "image", image: { id: "RS", mime_type: "image/jpeg" } }]);
    await waitFor(() => env.collector.metrics.get("backend_errors_total") >= 1, "first backend failure");
    await env.collector.stop();
    assert.strictEqual(env.collector.queue.stats().pending, 1, "job persisted with its downloaded file");
    env.proxy.setDown(false);
    const second = await env.makeCollector(env.config); // same DATA_DIR
    assert.strictEqual(second.collector.queue.stats().pending, 1, "recovered after restart");
    await waitFor(() => second.collector.queue.stats().pending === 0, "resumed job finished");
    assert.strictEqual(ingestion(env, "wamid.T12").mediaStatus, "stored");
    assert.strictEqual(env.platform.requests.filter((r) => r.includes("/wa-files/RS")).length, 1, "file was not downloaded again");
  } finally {
    await env.close();
  }
});

test("TEST 13: large files are refused before and during download; the message itself is kept", { skip }, async () => {
  const env = await environment();
  try {
    env.platform.files.set("BIG-DECLARED", { bytes: F.jpeg(1_200_000), mime: "image/jpeg" });
    env.platform.files.set("BIG-HIDDEN", { bytes: F.jpeg(1_200_000), mime: "image/jpeg", declareSize: false });
    await postWa(env, [
      { id: "wamid.T13a", type: "image", image: { id: "BIG-DECLARED", mime_type: "image/jpeg", caption: "big one" } },
      { id: "wamid.T13b", type: "image", image: { id: "BIG-HIDDEN", mime_type: "image/jpeg" } },
    ]);
    await drained(env);
    for (const id of ["wamid.T13a", "wamid.T13b"]) {
      const row = ingestion(env, id);
      assert.strictEqual(row.mediaStatus, "rejected");
      assert.strictEqual(row.mediaStatusReason, "size_limit_exceeded");
      assert.strictEqual(row.r2Key, null);
    }
    assert.strictEqual(env.r2.objects.size, 0);
    assert.ok(env.backend.state.messages.find((m) => m.clientMessageId === "wamid.T13a").messageText === "big one");
    assert.match(allLogText(env), /size_limit_exceeded/);
  } finally {
    await env.close();
  }
});

test("TEST 14: malformed and disguised files are rejected; invalid MIME rejected", { skip }, async () => {
  const env = await environment();
  try {
    env.platform.files.set("EXE", { bytes: F.exe(), mime: "application/pdf" });
    env.platform.files.set("CUT", { bytes: F.pdf().subarray(0, 40), mime: "application/pdf" });
    env.platform.files.set("MISMATCH", { bytes: F.jpeg(), mime: "application/pdf" });
    await postWa(env, [
      { id: "wamid.T14a", type: "document", document: { id: "EXE", mime_type: "application/pdf", filename: "report.pdf" } },
      { id: "wamid.T14b", type: "document", document: { id: "CUT", mime_type: "application/pdf", filename: "cut.pdf" } },
      { id: "wamid.T14c", type: "document", document: { id: "MISMATCH", mime_type: "application/pdf", filename: "x.pdf" } },
    ]);
    await drained(env);
    assert.strictEqual(ingestion(env, "wamid.T14a").mediaStatusReason, "unsupported_or_unrecognized_type");
    assert.strictEqual(ingestion(env, "wamid.T14b").mediaStatusReason, "malformed_file");
    assert.strictEqual(ingestion(env, "wamid.T14c").mediaStatusReason, "mime_type_mismatch");
    assert.strictEqual(env.r2.objects.size, 0);
  } finally {
    await env.close();
  }
});

test("TEST 15: path traversal filename never reaches the storage path", { skip }, async () => {
  const env = await environment();
  try {
    env.platform.files.set("PT", { bytes: F.pdf(), mime: "application/pdf" });
    await postWa(env, [{ id: "wamid.T15", type: "document", document: { id: "PT", mime_type: "application/pdf", filename: "../../../etc/passwd/..\\..\\report.pdf" } }]);
    await drained(env);
    const row = ingestion(env, "wamid.T15");
    assert.strictEqual(row.mediaStatus, "stored");
    assert.match(row.r2Key, /^whatsapp\/2026\/10\/09\/[0-9a-f-]{36}-report\.pdf$/);
    assert.ok(!row.r2Key.includes(".."));
    assert.strictEqual(row.originalFileName, "report.pdf");
  } finally {
    await env.close();
  }
});

test("webhook security: invalid signatures rejected; Meta verification handshake", { skip }, async () => {
  const env = await environment();
  try {
    const bad = await postWa(env, [{ id: "wamid.X", type: "text", text: { body: "forged" } }], { secret: "wrong-secret-0123456789" });
    assert.strictEqual(bad.status, 401);
    const unsigned = await fetch(`${env.base}/webhooks/viber`, { method: "POST", headers: { "Content-Type": "application/json" }, body: viberMessage({ type: "text", text: "forged" }) });
    assert.strictEqual(unsigned.status, 401);
    await drained(env);
    assert.strictEqual(env.backend.ingestions().length, 0);
    assert.match(allLogText(env), /webhook_signature_invalid/);
    const ok = await fetch(`${env.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${SECRETS.waVerifyToken}&hub.challenge=1158201444`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(await ok.text(), "1158201444");
    const no = await fetch(`${env.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1`);
    assert.strictEqual(no.status, 403);
    const big = await fetch(`${env.base}/webhooks/viber`, { method: "POST", body: Buffer.alloc(2 * 1024 * 1024) });
    assert.strictEqual(big.status, 413);
    assert.strictEqual((await fetch(`${env.base}/metrics`)).status, 404, "metrics disabled without METRICS_TOKEN");
    assert.strictEqual((await fetch(`${env.base}/admin/queue/retry-failed`, { method: "POST" })).status, 401);
  } finally {
    await env.close();
  }
});

test("expired platform token: retried, then the message is registered as media_unavailable (text not lost)", { skip }, async () => {
  const env = await environment();
  try {
    env.platform.setWhatsAppTokenValid(false);
    await env.collector.service.probePlatforms();
    const health = (await (await fetch(`${env.base}/health`)).json()) as any;
    assert.strictEqual(health.whatsapp.status, "auth_error");
    assert.strictEqual(health.viber.status, "connected");
    env.platform.files.set("EXP", { bytes: F.jpeg(), mime: "image/jpeg" });
    await postWa(env, [{ id: "wamid.EXP", type: "image", image: { id: "EXP", mime_type: "image/jpeg", caption: "Flood at Pasig" } }]);
    await drained(env);
    const row = ingestion(env, "wamid.EXP");
    assert.strictEqual(row.mediaStatus, "media_unavailable");
    assert.match(row.mediaStatusReason, /download failed after 4 attempts \(whatsapp_auth\)/);
    assert.strictEqual(env.r2.objects.size, 0);
    assertNoSecrets(env);
  } finally {
    await env.close();
  }
});

test("network timeout during download is retried; media the platform reports as unsupported is media_unavailable", { skip }, async () => {
  const env = await environment((c) => {
    c.limits.downloadTimeoutMs = 300;
  });
  try {
    env.platform.files.set("HANG", { bytes: F.jpeg(), mime: "image/jpeg", hang: true });
    await postWa(env, [
      { id: "wamid.HANG", type: "image", image: { id: "HANG", mime_type: "image/jpeg" } },
      { id: "wamid.UNS", type: "unsupported", errors: [{ code: 131051, title: "Message type unknown" }] },
    ]);
    await drained(env);
    assert.match(ingestion(env, "wamid.HANG").mediaStatusReason, /download failed after 4 attempts \(timeout\)/);
    assert.strictEqual(ingestion(env, "wamid.UNS").mediaStatus, "media_unavailable");
    assert.match(ingestion(env, "wamid.UNS").mediaStatusReason, /131051/);
  } finally {
    await env.close();
  }
});

test("collector token rejected by the backend: auth_error in health, job kept for retry", { skip }, async () => {
  const env = await environment((c) => {
    c.backend.token = "wrong-collector-token-0123456789abc";
    c.queue.maxAttempts = 50;
  });
  try {
    await postWa(env, [{ id: "wamid.AUTH", type: "text", text: { body: "Flood report" } }]);
    await waitFor(() => env.collector.service.backendState.status === "auth_error", "auth_error");
    assert.strictEqual(env.collector.queue.stats().pending, 1);
    assert.strictEqual(env.backend.ingestions().length, 0);
    assert.match(allLogText(env), /backend_auth_failed/);
  } finally {
    await env.close();
  }
});

test("pause from the Command Center: heartbeat delivers it, new messages are not collected", { skip }, async () => {
  const env = await environment();
  try {
    await env.backend.admin("/api/v1/collector/settings", { method: "PUT", body: JSON.stringify({ whatsappPaused: true, updatedBy: "test" }) });
    await env.collector.service.heartbeat({ status: "ok" });
    assert.strictEqual(env.collector.service.paused.whatsapp, true);
    await postWa(env, [{ id: "wamid.P", type: "text", text: { body: "while paused" } }]);
    await drained(env);
    assert.strictEqual(env.backend.ingestions().length, 0);
    const status = (await (await env.backend.admin("/api/v1/collector/status")).json()) as any;
    assert.strictEqual(status.collectors.length, 1);
    const h = (await (await fetch(`${env.base}/health`)).json()) as any;
    assert.strictEqual(h.whatsapp.status, "paused");
  } finally {
    await env.close();
  }
});

test("queue bound: when full, the webhook answers 503 so the platform redelivers", { skip }, async () => {
  const env = await environment((c) => {
    c.queue.maxItems = 1;
  });
  try {
    env.proxy.setDown(true);
    await postWa(env, [{ id: "wamid.Q1", type: "text", text: { body: "one" } }]);
    const res = await postWa(env, [{ id: "wamid.Q2", type: "text", text: { body: "two" } }]);
    assert.strictEqual(res.status, 503);
    assert.strictEqual(env.collector.queue.stats().pending, 1);
  } finally {
    await env.close();
  }
});

test("health reports real states only; no ids or content", { skip }, async () => {
  const env = await environment();
  try {
    let h = (await (await fetch(`${env.base}/health`)).json()) as any;
    assert.strictEqual(h.service, "okb-media-collector");
    assert.strictEqual(h.whatsapp.status, "unknown", "not connected before a real check");
    assert.strictEqual(h.r2.status, "unknown");
    await env.collector.service.probePlatforms();
    await env.collector.service.heartbeat({});
    h = (await (await fetch(`${env.base}/health`)).json()) as any;
    assert.strictEqual(h.whatsapp.status, "connected");
    assert.strictEqual(h.okbBackend.status, "connected");
    assert.strictEqual(h.r2.status, "configured", "R2 is not 'connected' until an upload succeeded");
    assert.deepStrictEqual(h.queue, { pending: 0, failed: 0, diskBytes: 0 });
    const text = JSON.stringify(h);
    assert.ok(!text.includes(WA_GROUP) && !text.includes(WA_SENDER));
  } finally {
    await env.close();
  }
});

test("longest multi-byte message text still fits the backend's request limit", { skip }, async () => {
  const env = await environment();
  try {
    const text = "🌊 Baha sa España ".repeat(1000); // > 8000 characters, 4-byte emoji included
    await postWa(env, [{ id: "wamid.LONG", type: "text", text: { body: text } }]);
    await drained(env);
    const msg = env.backend.state.messages.find((m) => m.clientMessageId === "wamid.LONG");
    assert.ok(msg, "registered");
    assert.strictEqual(msg.messageText.length, 8000);
  } finally {
    await env.close();
  }
});
