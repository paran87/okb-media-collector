# Architecture

## Assessment of the existing OKB system (before this component)

| Area | What exists | Reused? |
|---|---|---|
| Backend | `okb-bridge-cloud-backend`: dependency-free Node HTTP server on Render (Free), state in Supabase, loaded into memory at start | **Extended** with collector routes (additive) |
| Android bridge | Captures WhatsApp/Viber **notifications** on a phone; `POST /api/v1/messages`, media via `media/intent` → presigned R2 PUT → `media/complete`; consolidated TEXT/PDF delivery | **Not changed** |
| R2 | `lib/r2.js` SigV4 presigner; credentials only on the backend; bucket `okb-whatsapp-bridge-bucket` | **Reused**: the backend presigns uploads for the collector; added `presignHead` (additive) |
| Database | Supabase tables `okb_bridge_messages`, `okb_bridge_media`, `okb_bridge_media_links`, `okb_bridge_reports`, … (RLS on, service role only) | **Reused** for messages and media; one new table for ingestion records + two small status tables |
| Authentication | Bearer tokens: `OKB_DEVICE_TOKENS` (phones), `OKB_ADMIN_TOKENS` (Command Center) | **Same mechanism**, new separate `OKB_COLLECTOR_TOKENS` |
| AI pipeline | `lib/reports.js`: one report per message; deterministic prefilter (media-only and small talk never reach AI); OpenAI extraction from env config | **Reused unchanged**: collector messages enter through the same `onMessageStored` |
| Dedup | messages: `(fingerprint, platform)`; media: content-addressed key | **Reused**, plus SHA-256 lookup across all R2 media |
| Command Center | Next.js on Vercel; reads Supabase directly (server side), writes through the backend REST API; R2 SigV4 presigner for Operations galleries | **Reused**: new Media page reads Supabase and signs short-lived R2 links |

**Must not change:** the Android bridge's routes, contracts, object keys (`whatsapp/OKB-ANDROID-…/…/<sha>.<ext>`),
consolidated reports, and the AI configuration. None of them were changed.

**Compatibility notes**
- Collector messages are stored with `device_id = OKB-COLLECTOR-WHATSAPP|VIBER` and
  `platform_basis = collector_official`; they are not devices and never appear in the bridge-phone lists.
- A collector message whose text equals an Android-bridge message of the same platform within ±5 minutes is not
  stored twice: its file is linked to the Android message (and so to its report).
- The backend keeps state in memory; collector ingestion rows are loaded at start like the rest.

## Component diagram

```
 WhatsApp Cloud API                 Viber REST Bot API
 (business number:                  (OKB bot: 1:1 only)
  1:1 + API-created groups)
        │ HTTPS webhook                     │ HTTPS callback
        │ X-Hub-Signature-256               │ X-Viber-Content-Signature
        ▼                                   ▼
┌──────────────────────────── okb-media-collector (this repo) ────────────────────────────┐
│ server.ts ── WhatsAppAdapter ──┐                                                        │
│            └ ViberAdapter ─────┤ NormalizedMessage                                      │
│                                ▼                                                        │
│ MediaIngestionService.intake: pause flag → allowlist (ids) → PersistentQueue (disk)     │
│                                │  unauthorized: dropped, only a hashed-id audit entry   │
│ worker: download ─ stream to disk, size cap, SHA-256, magic-byte validation             │
│         upload   ─ backend: duplicate? else presigned PUT → stream file to R2           │
│         register ─ backend: message + true media outcome (Idempotency-Key)              │
│ /health  /metrics  audit log (DATA_DIR/audit)                                           │
└────────────────────────────────┬────────────────────────────────────────────────────────┘
          Bearer OKB_COLLECTOR_TOKEN │                    presigned PUT (no R2 keys in collector)
                                     ▼                                    ▼
┌──────── okb-bridge-cloud-backend (existing) ────────┐        ┌──── Cloudflare R2 ────┐
│ /api/v1/media-ingestion/upload-url  → key + presign │───────▶│ whatsapp/YYYY/MM/DD/  │
│ /api/v1/media-ingestion  → HEAD-verify, store msg,  │  HEAD  │ viber/YYYY/MM/DD/     │
│     media, link, okb_ingested_media row             │        │ (private)             │
│ existing reports.onMessageStored → prefilter → AI   │        └───────────────────────┘
│ /api/v1/collector/heartbeat|status|settings         │
└──────────────────────┬──────────────────────────────┘
                       ▼ Supabase (service role)
   okb_bridge_messages · okb_bridge_media · okb_bridge_media_links · okb_bridge_reports
   okb_ingested_media (new) · okb_collector_status (new) · okb_collector_settings (new)
                       ▲
┌──────────── OKB Command Center (okb-website-repo) ────────────┐
│ /command/media: filters, cards, View/Download via 10-min signed R2 URLs,  │
│ Copy reference, Open report, View message; access-key gated               │
│ Settings → OKB Media Collector: status, limits, allowlist counts, pause   │
└───────────────────────────────────────────────────────────────────────────┘

 Android OKB WhatsApp Bridge (unchanged) ──▶ /api/v1/messages, /api/v1/media/* (as before)
```

## Common message model

`src/model/message.ts` — `NormalizedMessage { source, mode, platformMessageId, conversationType, groupId,
groupName, senderId, senderName, messageText, receivedAt, messageType, media }` with
`media { available, kind, platformMediaId, filename, mimeType, size, downloadUrl, unavailableReason }`.
Fields a platform does not provide are `null`.

Idempotency key (collector and backend): `source:platformMessageId:platformMediaId|-`.

## Folder layout

```
src/
  adapters/MediaSourceAdapter.ts      platform-independent contract
  whatsapp/ WhatsAppAdapter.ts WhatsAppNormalizer.ts WhatsAppMediaHandler.ts types.ts
  viber/    ViberAdapter.ts    ViberNormalizer.ts    ViberMediaHandler.ts    types.ts
  okb/      OKBApiClient.ts    MediaIngestionService.ts
  storage/  R2Storage.ts       (streams to backend-presigned URLs)
  security/ validation.ts zip.ts filename.ts hashing.ts authentication.ts allowlist.ts safeFetch.ts
  queue/    PersistentQueue.ts retry.ts
  config/   environment.ts
  logging/  logger.ts audit.ts metrics.ts
  health/   health.ts
  server.ts app.ts index.ts tools/viber-set-webhook.ts
```

Database repositories live in the backend (`lib/collector/`), which stays the only writer of OKB data.

## Data stored per authorized message

| Where | Data |
|---|---|
| `okb_bridge_messages` | platform, group id/name, sender id/name, platform message id (`client_message_id`), timestamp, text, media type/status |
| `okb_bridge_media` (when a file is stored) | R2 key, SHA-256, size, MIME, original filename, sender/group name, message link |
| `okb_ingested_media` | idempotency key, provenance, media outcome + reason, R2 key, SHA-256, links to message/media/duplicate |
| R2 | the original bytes, unchanged; private bucket, served only through short-lived signed URLs |
| Collector disk | queued jobs (incl. message text) until registered; mode 0700/0600; deleted on completion |

Not stored: anything from conversations that are not allowlisted, contact cards, reactions, address books,
platform credentials.
