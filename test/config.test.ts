import assert from "node:assert";
import test from "node:test";
import { ConfigError, loadConfig } from "../src/config/environment";

const base = { OKB_BACKEND_URL: "https://okb-bridge-api.example.org", OKB_COLLECTOR_TOKEN: "x".repeat(32) };

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
}

test("both platforms are disabled by default; nothing is collected without configuration", () => {
  const c = loadConfig(base);
  assert.strictEqual(c.whatsapp.enabled, false);
  assert.strictEqual(c.viber.enabled, false);
  assert.strictEqual(c.limits.maxImageBytes, 25 * 1024 * 1024);
  assert.strictEqual(c.limits.maxDocumentBytes, 50 * 1024 * 1024);
  assert.strictEqual(c.limits.maxVideoBytes, 200 * 1024 * 1024);
});

test("enabling a platform without an allowlist is refused", () => {
  const p = problems({
    ...base, WHATSAPP_ENABLED: "true", WHATSAPP_GRAPH_API_VERSION: "v23.0", WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_APP_SECRET: "s",
    WHATSAPP_VERIFY_TOKEN: "v".repeat(20), WHATSAPP_PHONE_NUMBER_ID: "1",
  });
  assert.ok(p.some((x) => /ALLOWED_GROUP_IDS/.test(x)));
  assert.ok(problems({ ...base, VIBER_ENABLED: "true", VIBER_AUTH_TOKEN: "t" }).some((x) => /VIBER_ALLOWED_SENDER_IDS/.test(x)));
});

test("unsafe or unofficial settings are refused", () => {
  assert.ok(problems({ ...base, WHATSAPP_MODE: "experimental" }).some((x) => /official/.test(x)));
  assert.ok(problems({ ...base, VIBER_MODE: "web" }).some((x) => /official/.test(x)));
  assert.ok(problems({ ...base, NODE_ENV: "production", OKB_BACKEND_URL: "http://backend" }).some((x) => /https/.test(x)));
  assert.ok(problems({ ...base, NODE_ENV: "production", LOG_MESSAGE_CONTENT: "true" }).length > 0);
  assert.ok(problems({ ...base, OKB_COLLECTOR_TOKEN: "short" }).length > 0);
  assert.ok(problems({ OKB_BACKEND_URL: base.OKB_BACKEND_URL }).some((x) => /OKB_COLLECTOR_TOKEN/.test(x)));
  assert.ok(problems({ ...base, MAX_IMAGE_SIZE_MB: "0" }).length > 0);
  assert.ok(problems({ ...base, WHATSAPP_ALLOWED_GROUP_IDS: "bad id with spaces" }).length > 0);
});

test("allowlist entries: id or id|label, duplicates removed, base64 ids with '=' kept intact", () => {
  const c = loadConfig({ ...base, WHATSAPP_ALLOWED_GROUP_IDS: "g1@g.us|OKB NCR, g2@g.us ,g1@g.us|dup", VIBER_ALLOWED_SENDER_IDS: "01234567890A=,AbC+/x==|Juan" });
  assert.deepStrictEqual(c.whatsapp.allowedGroups, [{ id: "g1@g.us", label: "OKB NCR" }, { id: "g2@g.us", label: null }]);
  assert.deepStrictEqual(c.viber.allowedSenders, [{ id: "01234567890A=", label: null }, { id: "AbC+/x==", label: "Juan" }]);
});
