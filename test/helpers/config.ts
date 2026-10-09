import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../src/config/environment";

export const SECRETS = {
  backendToken: "test-collector-token-0123456789abcdef",
  waAccessToken: "EAAG-test-access-token-0123456789",
  waAppSecret: "wa-app-secret-0123456789abcdef",
  waVerifyToken: "wa-verify-token-0123456789",
  viberToken: "viber-auth-token-0123456789abcdef",
};

export const WA_PHONE_NUMBER_ID = "106540352242922";
export const WA_GROUP = "120363025555555555@g.us";
export const WA_OTHER_GROUP = "120363099999999999@g.us";
export const WA_SENDER = "639170000001";
export const VIBER_SENDER = "01234567890A=";

/** A validated config (through loadConfig) adjusted for local tests: fast retries, local hosts. */
export function testConfig(overrides: Partial<Record<string, string>> = {}, patch: (c: Config) => void = () => undefined): Config {
  const dataDir = mkdtempSync(join(tmpdir(), "okb-collector-"));
  const c = loadConfig({
    NODE_ENV: "test",
    OKB_BACKEND_URL: "http://127.0.0.1:9",
    OKB_COLLECTOR_TOKEN: SECRETS.backendToken,
    DATA_DIR: dataDir,
    WHATSAPP_ENABLED: "true",
    WHATSAPP_GRAPH_API_VERSION: "v23.0",
    WHATSAPP_ACCESS_TOKEN: SECRETS.waAccessToken,
    WHATSAPP_APP_SECRET: SECRETS.waAppSecret,
    WHATSAPP_VERIFY_TOKEN: SECRETS.waVerifyToken,
    WHATSAPP_PHONE_NUMBER_ID: WA_PHONE_NUMBER_ID,
    WHATSAPP_ALLOWED_GROUP_IDS: `${WA_GROUP}|OKB NCR Flood Reports`,
    WHATSAPP_ALLOWED_SENDER_IDS: WA_SENDER,
    VIBER_ENABLED: "true",
    VIBER_AUTH_TOKEN: SECRETS.viberToken,
    VIBER_ALLOWED_SENDER_IDS: VIBER_SENDER,
    MAX_IMAGE_SIZE_MB: "1",
    MAX_DOCUMENT_SIZE_MB: "1",
    MAX_VIDEO_SIZE_MB: "2",
    QUEUE_MAX_DISK_MB: "100",
    RETRY_BASE_DELAY_MS: "10",
    RETRY_MAX_ATTEMPTS: "4",
    ...overrides,
  });
  c.queue.maxDelayMs = 50;
  c.whatsapp.mediaHosts = ["127.0.0.1"];
  c.viber.mediaHosts = ["127.0.0.1"];
  patch(c);
  return c;
}
