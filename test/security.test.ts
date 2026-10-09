import assert from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createLogger } from "../src/logging/logger";
import { Allowlist } from "../src/security/allowlist";
import { hmacSha256Hex, verifyHmacSignature } from "../src/security/authentication";
import { originalFileName, safeFileName } from "../src/security/filename";
import { matchesDeclaredSha256, sha256Hex } from "../src/security/hashing";
import { checkUrl } from "../src/security/safeFetch";
import { validateFile } from "../src/security/validation";
import { testConfig } from "./helpers/config";
import * as F from "./helpers/fixtures";

const cfg = testConfig();

async function check(bytes: Buffer, declaredMime: string | null, fileName: string | null) {
  const path = join(cfg.dataDir, `v-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, bytes);
  return validateFile({ path, size: bytes.length, declaredMime, fileName, limits: cfg.limits });
}

test("validation accepts real files and decides the type from the content", async () => {
  const cases: [Buffer, string | null, string | null, string][] = [
    [F.jpeg(), "image/jpeg", null, "jpg"],
    [F.jpeg(), "image/jpg", "IMG_0001.JPEG", "jpg"],
    [F.png(), null, "photo.png", "png"],
    [F.mp4(), "video/mp4", "clip.mp4", "mp4"],
    [F.pdf(), "application/pdf", "Flood Report.pdf", "pdf"],
    [F.docx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "report.docx", "docx"],
    [F.xlsx(), "application/octet-stream", "levels.xlsx", "xlsx"],
    [F.ole(), "application/msword", "old.doc", "doc"],
    [Buffer.from("Water level 1.2m at 3pm\n"), "text/plain", "notes.txt", "txt"],
  ];
  for (const [bytes, mime, name, ext] of cases) {
    const r = await check(bytes, mime, name);
    assert.ok(r.ok, `${name ?? mime} should be accepted: ${JSON.stringify(r)}`);
    if (r.ok) assert.strictEqual(r.detected.ext, ext);
  }
});

test("validation rejects disguised, malformed and unsafe files", async () => {
  const cases: [Buffer, string | null, string | null, string][] = [
    [F.exe(), "application/pdf", "report.pdf", "unsupported_or_unrecognized_type"],
    [F.exe(), null, "setup.exe", "unsupported_or_unrecognized_type"],
    [F.jpeg(), "application/pdf", "report.pdf", "mime_type_mismatch"],
    [F.jpeg(), "image/jpeg", "photo.pdf", "extension_mismatch"],
    [F.pdf().subarray(0, 30), "application/pdf", "cut.pdf", "malformed_file"],
    [F.docx([{ name: "word/vbaProject.bin", data: Buffer.from("macro") }]), null, "macro.docx", "macro_content"],
    [F.zip([{ name: "[Content_Types].xml", data: Buffer.from("x") }, { name: "../../evil.sh", data: Buffer.from("x") }]), null, "a.docx", "zip_unsafe"],
    [F.zip([{ name: "[Content_Types].xml", data: Buffer.from("x") }, { name: "word/document.xml", data: Buffer.alloc(2000), claimUncompressed: 4_000_000_000 }]), null, "bomb.docx", "zip_unsafe"],
    [F.zip([{ name: "[Content_Types].xml", data: Buffer.from("x") }, { name: "word/document.xml", data: Buffer.from("x"), encrypted: true }]), null, "enc.docx", "zip_unsafe"],
    [F.zip([{ name: "readme.txt", data: Buffer.from("x") }]), "application/zip", "archive.zip", "unsupported_or_unrecognized_type"],
    [Buffer.from([0x41, 0x00, 0x42]), "text/plain", "bin.txt", "text_not_utf8"],
    [F.ole(), null, "mystery.bin", "unsupported_or_unrecognized_type"],
    [Buffer.alloc(0), "image/jpeg", "empty.jpg", "empty_file"],
    [F.jpeg(2 * 1024 * 1024), "image/jpeg", "huge.jpg", "size_limit_exceeded"],
  ];
  for (const [bytes, mime, name, reason] of cases) {
    const r = await check(bytes, mime, name);
    assert.strictEqual(r.ok, false, `${name} must be rejected`);
    if (!r.ok) assert.strictEqual(r.reason, reason, `${name}: ${JSON.stringify(r)}`);
  }
});

test("filenames: no path traversal, no control characters, bounded, extension from the detected type", () => {
  assert.strictEqual(safeFileName("../../etc/passwd", "jpg"), "passwd.jpg");
  assert.strictEqual(safeFileName("..\\..\\windows\\system32\\cmd.exe", "pdf"), "cmd.pdf");
  assert.strictEqual(safeFileName(".hidden", "txt"), "media.txt");
  assert.strictEqual(safeFileName("Flood\u0000 photo‮ gpj.exe", "jpg"), "Flood-photo-gpj.jpg");
  assert.strictEqual(safeFileName("Baha sa España.pdf", "pdf"), "Baha-sa-Espana.pdf");
  assert.strictEqual(safeFileName(null, "png"), "media.png");
  assert.ok(safeFileName("x".repeat(500), "jpg").length <= 84);
  assert.strictEqual(safeFileName("evil.php", "../x"), "evil.bin");
  assert.strictEqual(originalFileName("/tmp/../report\r\n.pdf"), "report.pdf");
});

test("webhook signatures: raw-body HMAC, constant-time, wrong or missing rejected", () => {
  const body = Buffer.from('{"a":"é"}');
  const sig = hmacSha256Hex("secret-123456", body);
  assert.ok(verifyHmacSignature("secret-123456", body, `sha256=${sig}`, "sha256="));
  assert.ok(!verifyHmacSignature("secret-123456", Buffer.from('{"a":"\\u00e9"}'), `sha256=${sig}`, "sha256="), "re-serialized JSON does not match");
  assert.ok(!verifyHmacSignature("secret-123456", body, sig, "sha256="), "prefix required");
  assert.ok(!verifyHmacSignature("other-secret", body, `sha256=${sig}`, "sha256="));
  assert.ok(!verifyHmacSignature("secret-123456", body, undefined));
  assert.ok(!verifyHmacSignature("", body, sig));
});

test("allowlist: ids only, nothing by default, groups unsupported on Viber", () => {
  const a = new Allowlist([{ id: "g1", label: "OKB NCR" }], [{ id: "s1", label: null }], true);
  assert.deepStrictEqual(a.decide({ conversationType: "group", groupId: "g1", senderId: "x" }), { allowed: true, label: "OKB NCR" });
  assert.strictEqual(a.decide({ conversationType: "group", groupId: "g2", senderId: "s1" }).allowed, false);
  assert.strictEqual(a.decide({ conversationType: "group", groupId: null, senderId: "s1" }).allowed, false);
  assert.strictEqual(a.decide({ conversationType: "direct", groupId: null, senderId: "s1" }).allowed, true);
  assert.strictEqual(a.decide({ conversationType: "direct", groupId: null, senderId: "s2" }).allowed, false);
  const empty = new Allowlist([], [], true);
  assert.strictEqual(empty.decide({ conversationType: "direct", groupId: null, senderId: "s1" }).allowed, false);
  const viber = new Allowlist([{ id: "g1", label: null }], [], false);
  assert.deepStrictEqual(viber.decide({ conversationType: "group", groupId: "g1", senderId: "s" }), { allowed: false, reason: "group_capture_unsupported" });
});

test("logger never prints secrets, credential fields, or message text by default", () => {
  const lines: string[] = [];
  const log = createLogger({ level: "debug", secrets: ["super-secret-token-value"], write: (l) => lines.push(l) });
  log.info("x", { authorization: "Bearer abc", nested: { apiKey: "k", uploadUrl: "https://r2/?X-Amz-Signature=1" }, msg: "failed for super-secret-token-value" });
  log.error("y", { error: new Error(`token ${encodeURIComponent("super-secret-token-value")}`) });
  log.info("z", { text: log.content("Flood at Taft Ave") });
  const out = lines.join("\n");
  assert.ok(!out.includes("super-secret-token-value"));
  assert.ok(!out.includes("Bearer abc"));
  assert.ok(!out.includes("X-Amz-Signature"));
  assert.ok(!out.includes("Flood at Taft"));
  assert.match(out, /"length":17/);
  assert.notStrictEqual(log.ref("639170000001"), "639170000001");
});

test("SSRF guard: https + allowlisted host + no private addresses", async () => {
  const p = { allowedHosts: ["fbsbx.com"] };
  await assert.rejects(checkUrl("http://lookaside.fbsbx.com/x", p), /protocol/);
  await assert.rejects(checkUrl("https://evil.example.com/x", p), /host not allowlisted/);
  await assert.rejects(checkUrl("https://fbsbx.com.evil.example/x", p), /host not allowlisted/);
  await assert.rejects(checkUrl("https://user:pw@lookaside.fbsbx.com/x", p), /credentials/);
  await assert.rejects(checkUrl("https://127.0.0.1/x", { allowedHosts: ["127.0.0.1"] }), /private address/);
  await assert.rejects(checkUrl("https://[::1]/x", { allowedHosts: ["::1"] }), /private address|host not allowlisted/);
});

test("platform checksum comparison accepts hex and base64, flags mismatch", () => {
  const ours = sha256Hex("abc");
  assert.strictEqual(matchesDeclaredSha256(ours, ours), true);
  assert.strictEqual(matchesDeclaredSha256(ours, Buffer.from(ours, "hex").toString("base64")), true);
  assert.strictEqual(matchesDeclaredSha256(ours, sha256Hex("abd")), false);
  assert.strictEqual(matchesDeclaredSha256(ours, "not-a-hash"), null);
  assert.strictEqual(matchesDeclaredSha256(ours, null), null);
});
