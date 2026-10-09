import { hmacSha256Hex } from "../../src/security/authentication";
import type { WaMessage, WaWebhookBody } from "../../src/whatsapp/types";
import { SECRETS, VIBER_SENDER, WA_PHONE_NUMBER_ID, WA_SENDER } from "./config";

/** WhatsApp Cloud API webhook in the shape of Meta's documented samples. */
export function waWebhook(messages: Partial<WaMessage>[], phoneNumberId = WA_PHONE_NUMBER_ID, from = WA_SENDER): WaWebhookBody {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "MM3DEO" }, wa_id: from }],
              messages: messages.map((m) => ({ from, timestamp: "1791556920", ...m })),
            },
          },
        ],
      },
    ],
  };
}

export function waSigned(body: unknown, secret = SECRETS.waAppSecret): { raw: string; headers: Record<string, string> } {
  const raw = JSON.stringify(body);
  return { raw, headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${hmacSha256Hex(secret, Buffer.from(raw))}` } };
}

// Unique across processes (a fixed start collided between separate staging runs).
let token = BigInt(Date.now()) * 1_000_000n + BigInt(process.pid % 1_000_000);
export function viberMessage(message: Record<string, unknown>, sender = VIBER_SENDER): string {
  token += 1n;
  // message_token as a bare 64-bit JSON number, like Viber sends it.
  return `{"event":"message","timestamp":1791556920000,"message_token":${token.toString()},"sender":{"id":${JSON.stringify(sender)},"name":"Viber Reporter"},"message":${JSON.stringify(message)}}`;
}

export function viberSigned(raw: string, secret = SECRETS.viberToken): Record<string, string> {
  return { "Content-Type": "application/json", "X-Viber-Content-Signature": hmacSha256Hex(secret, Buffer.from(raw)) };
}
