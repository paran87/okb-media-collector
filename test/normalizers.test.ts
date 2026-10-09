import assert from "node:assert";
import test from "node:test";
import { boundedText } from "../src/model/message";
import { normalizeViberCallback, rawMessageToken } from "../src/viber/ViberNormalizer";
import { normalizeWhatsAppWebhook } from "../src/whatsapp/WhatsAppNormalizer";
import { WA_GROUP, WA_PHONE_NUMBER_ID, WA_SENDER } from "./helpers/config";
import { waWebhook } from "./helpers/payloads";

test("WhatsApp group text (Meta's documented group webhook shape)", () => {
  const { messages } = normalizeWhatsAppWebhook(waWebhook([{ id: "wamid.T1", type: "text", text: { body: "Flood at Taft" }, group_id: WA_GROUP }]), WA_PHONE_NUMBER_ID);
  assert.strictEqual(messages.length, 1);
  const m = messages[0]!;
  assert.strictEqual(m.conversationType, "group");
  assert.strictEqual(m.groupId, WA_GROUP);
  assert.strictEqual(m.senderId, WA_SENDER);
  assert.strictEqual(m.senderName, "MM3DEO");
  assert.strictEqual(m.messageText, "Flood at Taft");
  assert.strictEqual(m.platformMessageId, "wamid.T1");
  assert.strictEqual(m.receivedAt, "2026-10-09T14:42:00.000Z");
  assert.strictEqual(m.media, null);
});

test("WhatsApp media, document filename, caption, location, unsupported, ignored types", () => {
  const { messages, skipped } = normalizeWhatsAppWebhook(
    waWebhook([
      { id: "a", type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", sha256: "x", caption: "Baha sa Espana" } },
      { id: "b", type: "document", document: { id: "MEDIA2", mime_type: "application/pdf", filename: "report.pdf" } },
      { id: "c", type: "location", location: { latitude: 14.6, longitude: 120.98, name: "PGH" } },
      { id: "d", type: "unsupported", errors: [{ code: 131051 }] },
      { id: "e", type: "contacts" },
      { id: "f", type: "reaction" },
      { id: "g", type: "audio", audio: { id: "MEDIA3", mime_type: "audio/ogg", voice: true } },
    ]),
    WA_PHONE_NUMBER_ID,
  );
  assert.strictEqual(skipped, 2, "contacts cards and reactions are not collected");
  const byId = new Map(messages.map((m) => [m.platformMessageId, m]));
  assert.strictEqual(byId.get("a")!.media!.platformMediaId, "MEDIA1");
  assert.strictEqual(byId.get("a")!.messageText, "Baha sa Espana");
  assert.strictEqual(byId.get("a")!.conversationType, "direct");
  assert.strictEqual(byId.get("b")!.media!.filename, "report.pdf");
  assert.match(byId.get("c")!.messageText!, /\[Location\] PGH \(14\.6, 120\.98\)/);
  assert.strictEqual(byId.get("d")!.media!.available, false);
  assert.match(byId.get("d")!.media!.unavailableReason!, /131051/);
  assert.strictEqual(byId.get("g")!.media!.kind, "audio");
});

test("WhatsApp: other phone numbers, statuses and foreign objects are ignored", () => {
  assert.strictEqual(normalizeWhatsAppWebhook(waWebhook([{ id: "x", type: "text", text: { body: "hi" } }], "999"), WA_PHONE_NUMBER_ID).messages.length, 0);
  const statuses = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: WA_PHONE_NUMBER_ID }, statuses: [{}] } }] }] };
  assert.strictEqual(normalizeWhatsAppWebhook(statuses, WA_PHONE_NUMBER_ID).messages.length, 0);
  assert.strictEqual(normalizeWhatsAppWebhook({ object: "page" }, WA_PHONE_NUMBER_ID).messages.length, 0);
  assert.strictEqual(normalizeWhatsAppWebhook(JSON.parse('{"entry":5}'), WA_PHONE_NUMBER_ID).messages.length, 0);
});

test("Viber: 64-bit message_token keeps every digit; file, picture, non-message events", () => {
  const raw = '{"event":"message","timestamp":1791557040000,"message_token":4912661846655238145,"sender":{"id":"01234567890A=","name":"Juan"},"message":{"type":"file","media":"https://dl-media.viber.com/f","file_name":"report.pdf","file_size":1234}}';
  assert.strictEqual(rawMessageToken(raw), "4912661846655238145");
  const { message } = normalizeViberCallback(JSON.parse(raw), raw);
  assert.strictEqual(message!.platformMessageId, "4912661846655238145");
  assert.strictEqual(message!.conversationType, "direct");
  assert.strictEqual(message!.media!.kind, "document");
  assert.strictEqual(message!.media!.size, 1234);
  assert.strictEqual(message!.media!.filename, "report.pdf");
  const seen = '{"event":"seen","timestamp":1,"message_token":1,"user_id":"x"}';
  assert.strictEqual(normalizeViberCallback(JSON.parse(seen), seen).skipped, true);
  const contact = '{"event":"message","timestamp":1,"message_token":2,"sender":{"id":"a"},"message":{"type":"contact","contact":{"name":"x","phone_number":"1"}}}';
  assert.strictEqual(normalizeViberCallback(JSON.parse(contact), contact).message, null, "contact cards are not collected");
});

test("text truncation never splits an emoji (no lone surrogates reach the database)", () => {
  const t = boundedText(`a${"🌊".repeat(10)}`, 4)!;
  assert.strictEqual(t, "a🌊");
  assert.ok(!/[\ud800-\udbff]$/.test(t));
  assert.strictEqual(boundedText("   ", 10), null);
  assert.strictEqual(boundedText(5, 10), null);
});
