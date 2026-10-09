# Platform capabilities (checked 9 October 2026; statuses updated after staging validation)

This page records what the **official** WhatsApp and Viber APIs can and cannot do for OKB, from the platforms' own
documentation. The collector only implements what is listed as supported here. Anything marked
"not documented" must be confirmed with a real, authorized test before anyone relies on it (see
[TEST-PLAN.md](TEST-PLAN.md), Phase 18).

Sources:
- Meta, WhatsApp Groups API overview: <https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/>
- Meta, Group messaging (webhooks): <https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging/>
- Meta, Media API: <https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media/>
- Meta, WhatsApp changelog: <https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog>
- Rakuten Viber, REST Bot API: <https://developers.viber.com/docs/api/rest-bot-api/>

## Status of each capability (9 October 2026)

Legend: **Yes** = done and evidenced · **No** = not done · **n/a** = cannot apply. "Simulated" = automated tests and the
local staging stack, where WhatsApp/Viber are local fakes built from the documented payloads. Only the
"Real account" column proves what the platforms actually deliver, and it is empty because no real account has
been connected yet.

| Capability | Implemented in code | Passed simulated tests | Passed real-account tests | Deployed to test | Ready for production | Unsupported by the platform |
|---|---|---|---|---|---|---|
| WhatsApp: read existing ordinary OKB groups | No (nothing official to call) | n/a | n/a | n/a | n/a | **Yes — unsupported** (`OFFICIAL_WHATSAPP_MEDIA_CAPTURE_LIMITATION`) |
| WhatsApp 1:1 to OKB business number: text | Yes | Yes | No | No | No | No |
| WhatsApp 1:1: photo / PDF / DOCX / XLSX / video | Yes | Yes | No | No | No | No |
| WhatsApp API-created group (≤ 8, OBA): text | Yes | Yes | No | No | No | No |
| WhatsApp API-created group: photo / documents | Yes | Yes | No | No | No | **Unknown** — Meta documents text only; needs real Test A |
| Viber: read existing groups / Communities | No (nothing official to call) | n/a | n/a | n/a | n/a | **Yes — unsupported** (`VIBER_MEDIA_CAPTURE_UNSUPPORTED`) |
| Viber 1:1 to OKB bot: text / photo / video | Yes | Yes | No | No | No | No |
| Viber 1:1: PDF / DOCX from a user | Yes (handled if it arrives) | Yes | No | No | No | **Probably** — Viber docs say `file` is not supported user→bot |
| Storage in R2, SHA-256 dedupe, verification before "stored" | Yes | Yes (staging: byte-identical objects) | No | No | No | n/a |
| Queue, retries, restart recovery (Docker image + volume) | Yes | Yes (container tested) | n/a | No | No | n/a |
| Command Center media page, signed links, pause/resume | Yes | Yes (staging, real PostgreSQL/PostgREST) | n/a | No | No | n/a |
| Experimental WhatsApp Web / Viber automation | **No — deliberately not built** | n/a | n/a | n/a | n/a | Against platform terms |

## Direct answers

1. **Can the official WhatsApp integration receive messages from our existing ordinary reporting GC?** No. The
   Cloud API cannot join or read a group it did not create. This is a platform limitation, not missing configuration.
2. **Can it download original photos from that GC?** No (it receives nothing from that GC).
3. **Can it download PDFs and Word documents?** Yes, when they are sent **1:1 to the OKB business number**
   (documented Media API; up to 100 MB on WhatsApp's side, 50 MB by our default limit). For API-created groups it
   is not documented and must be tested. Never from the existing GC.
4. **Can the official Viber integration read our existing GC?** No. Bots only have 1:1 conversations.
5. **Can it download original photos and documents?** Photos and videos sent 1:1 to the bot: yes (URL valid 1 hour).
   Documents: Viber documents them as not supported from user to bot — expect no.
6. **Which workflows still require the Android phone?** Everything that depends on the existing ordinary WhatsApp
   groups: capturing reports from the source group (notifications), and sending the automated consolidated TEXT
   and the PDF into the destination group (the Cloud API cannot post into an ordinary group either).
7. **Which reporting workflows can run entirely on Render?** Reporters who send text/photos/documents **directly**
   to an OKB WhatsApp Business number (or text/photos/videos to an OKB Viber bot) → collector → backend → R2 → AI →
   Command Center. No phone involved. Also any reporting group created by an OBA through the Groups API (≤ 8 people),
   subject to Test A confirming media.
8. **What limitations remain?** Existing groups are out of reach of official APIs; API-created WhatsApp groups are
   capped at 8 and need an OBA; Viber needs a commercial bot and has no groups or (probably) documents; photos and
   videos may be compressed by the platform; no text extraction from PDF/DOCX into the AI yet; no real-account test yet.

## Summary

| Question | WhatsApp (Cloud API, official) | Viber (REST Bot API, official) |
|---|---|---|
| Receive messages from an **existing, ordinary** group (like today's OKB groups)? | **No** — `OFFICIAL_WHATSAPP_MEDIA_CAPTURE_LIMITATION` | **No** — `VIBER_MEDIA_CAPTURE_UNSUPPORTED` |
| Receive group messages at all? | Only in groups **created by the business through the Groups API** | No group or Community callbacks |
| Requirements for groups | Official Business Account (OBA); max **8 participants**; members join only by invite link; not for WhatsApp Business app numbers | — |
| Receive 1:1 messages? | Yes, sent to the business number | Yes, sent to the bot |
| Business account / number | WhatsApp Business Platform number (Cloud API) | A Viber bot; since 5 Feb 2024 new bots only on commercial terms |
| Webhook | HTTPS (trusted CA), GET verify token, `X-Hub-Signature-256` HMAC with the app secret | HTTPS (trusted CA, no self-signed), `X-Viber-Content-Signature` HMAC with the bot token; must answer 200 |
| Original media download | Media id → `GET /{media-id}` → URL (valid **5 minutes**) → download with bearer token; ids downloadable for a limited time (Meta: 7 days) | Media URL in the callback, valid **1 hour** |
| Size limits (platform) | Image 5 MB (JPEG/PNG), video 16 MB (MP4/3GPP), document 100 MB, audio 16 MB, sticker WebP | Bot→user: file 50 MB, video 26 MB; user→bot limits not documented |
| History | No — webhook only, from subscription onward | No |

## Capability matrix

| Feature | WhatsApp Official | WhatsApp Experimental | Viber Official | Viber Experimental |
|---|---|---|---|---|
| Text | Yes (1:1; API-created groups) | Not implemented | Yes (1:1 with bot) | Not implemented |
| Photo | Yes (1:1). In API-created groups: **not documented** (Meta's group webhook sample shows text only) | Not implemented | Yes (`picture`, 1:1) | Not implemented |
| Video | Yes (1:1); groups not documented | Not implemented | Yes (`video`, 1:1) | Not implemented |
| PDF | Yes (`document`, 1:1); groups not documented | Not implemented | **Not documented as supported** (docs: "excluding `file` type"); handled if it arrives | Not implemented |
| DOC/DOCX | Yes (`document`, 1:1) | Not implemented | Not documented as supported | Not implemented |
| XLS/XLSX | Yes (`document`, 1:1) | Not implemented | Not documented as supported | Not implemented |
| Sender | Yes: phone number (`from`) + profile name | Not implemented | Yes: `sender.id` + name | Not implemented |
| Group | `group_id` only (name from the allowlist label); API-created groups only | Not implemented | **No** | Not implemented |
| Timestamp | Yes (seconds) | Not implemented | Yes (milliseconds) | Not implemented |
| Original media | Yes, as WhatsApp delivers it (photos/videos sent as media may already be compressed by WhatsApp; documents unchanged) | Not implemented | As Viber serves it (may be compressed) | Not implemented |

## What this means for OKB

1. **Existing OKB WhatsApp groups cannot be read by any official API.** They remain with the Android bridge
   (notification capture), which is unchanged.
2. The **official** ways to receive original files are:
   - **WhatsApp 1:1:** field reporters send reports/photos/documents directly to an OKB WhatsApp Business number.
     This is fully supported, has no participant limit, and the collector stores the original files.
   - **WhatsApp API-created group:** an OBA can create small (≤ 8 people) reporting groups. Text is documented;
     whether photos/documents posted in these groups reach the webhook must be confirmed (TEST 2–4 with a real account).
   - **Viber 1:1 with an OKB bot:** text, photos and videos. Requires a commercial Viber bot.
3. Each collected message is stored with its true media outcome (`stored`, `duplicate`, `media_unavailable`,
   `rejected`, `not_collected`). A file is never reported as captured unless it is in R2 and verified there.

## Experimental / unofficial integrations — evaluated, NOT implemented

WhatsApp Web automation (e.g. libraries that log in as a linked device and read groups) or Viber desktop/UI
automation could technically read existing groups. They are **not included**, because they:

- use an unofficial client, which WhatsApp's and Viber's terms do not allow; the number used can be **banned
  without notice**, which would silently stop flood reporting;
- break whenever the platform changes its web client, with no support channel;
- require storing a full session credential of a WhatsApp account on a server (high-value secret);
- would be the only path for the existing groups, which the requirements forbid for critical reporting.

The adapter interface (`src/adapters/MediaSourceAdapter.ts`) keeps a `mode: "experimental"` slot so such an
adapter could be added later in isolation (own dependencies, own enable flag, disabled by default, dedicated
secondary account, allowlist, kill switch, health status). The configuration currently **refuses**
`WHATSAPP_MODE`/`VIBER_MODE` values other than `official`. Adding one is a decision for the OKB administrator after
accepting the account-ban and terms risks above.
