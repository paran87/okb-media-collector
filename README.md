# OKB Media Collector

Collects messages and media from **authorized** OKB reporting channels on WhatsApp and Viber through the
platforms' **official** APIs, stores original files in Cloudflare R2 and registers everything with the existing
OKB backend, so the existing AI report pipeline and the OKB Command Center see it.

It is a **separate service** from the Android OKB WhatsApp Bridge, which keeps running unchanged.

```
WhatsApp Cloud API / Viber Bot API ──signed webhook──▶ collector (allowlist, queue, validation)
   ──▶ okb-bridge-cloud-backend (presigned R2 upload, message + media registration)
   ──▶ existing report pipeline (AI only when the text needs it) ──▶ OKB Command Center (Media page)
```

## Read this first: what the official APIs can do

| | Existing ordinary groups | What works officially |
|---|---|---|
| WhatsApp | **No** (`OFFICIAL_WHATSAPP_MEDIA_CAPTURE_LIMITATION`) | 1:1 messages to an OKB business number; groups created by an Official Business Account via the Groups API (≤ 8 participants; group media not yet confirmed) |
| Viber | **No** (`VIBER_MEDIA_CAPTURE_UNSUPPORTED`) | 1:1 messages to an OKB bot (text, photos, videos; files not documented as supported) |

Details and sources: [docs/CAPABILITIES.md](docs/CAPABILITIES.md). No unofficial adapter is included; the
evaluation of WhatsApp Web / Viber automation and why it was not built is in the same document.

**Status (9 Oct 2026):** implemented; 39 automated tests pass; validated on a local staging stack (real
PostgreSQL/PostgREST, the branch backend, the Docker image, the Command Center) with **simulated** WhatsApp/Viber
APIs — see [docs/TEST-PLAN.md](docs/TEST-PLAN.md). **Not yet deployed to a test environment and not yet tested with
real WhatsApp/Viber accounts**; do not rely on any platform capability before Test A / Test B have been run.

## Quick start (local)

```bash
npm ci
cp .env.example .env    # fill in; keep platforms disabled at first
set -a; . ./.env; set +a
npm run build && npm start
curl localhost:8090/health
npm test                # needs ../okb-bridge-cloud-backend with `npm install`
```

## Configuration

All settings are environment variables; see [.env.example](.env.example). The service refuses to start with an
unsafe configuration (missing allowlist for an enabled platform, http backend in production, short tokens,
content logging in production, non-official modes).

| Variable | Purpose |
|---|---|
| `OKB_BACKEND_URL`, `OKB_COLLECTOR_TOKEN` | Existing backend + this collector's token (one of the backend's `OKB_COLLECTOR_TOKENS`) |
| `WHATSAPP_ENABLED`, `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API |
| `WHATSAPP_ALLOWED_GROUP_IDS`, `WHATSAPP_ALLOWED_SENDER_IDS` | Allowlists: `id` or `id\|Display name`, comma separated |
| `VIBER_ENABLED`, `VIBER_AUTH_TOKEN`, `VIBER_ALLOWED_SENDER_IDS` | Viber bot (1:1) |
| `VIBER_ALLOWED_GROUP_IDS` | Accepted but unusable (groups unsupported by Viber's API) |
| `WHATSAPP_MEDIA_HOSTS`, `VIBER_MEDIA_HOSTS` | Hosts media may be downloaded from |
| `MAX_IMAGE_SIZE_MB` (25), `MAX_DOCUMENT_SIZE_MB` (50), `MAX_VIDEO_SIZE_MB` (200) | Size limits |
| `QUEUE_MAX_ITEMS`, `QUEUE_MAX_DISK_MB`, `RETRY_*`, `WORKER_CONCURRENCY` | Durable queue and retries |
| `METRICS_TOKEN`, `COLLECTOR_ADMIN_TOKEN` | Enable `/metrics` and `/admin/queue/retry-failed` |

R2 credentials are **not** configured here: the backend, which already owns the R2 client, issues presigned
upload URLs.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Status per platform, R2, backend, queue (no ids or content) |
| `GET /metrics` | `METRICS_TOKEN` | Prometheus counters/gauges |
| `GET/POST /webhooks/whatsapp` | Meta verify token / `X-Hub-Signature-256` | Cloud API webhook |
| `POST /webhooks/viber` | `X-Viber-Content-Signature` | Viber callback |
| `POST /admin/queue/retry-failed` | `COLLECTOR_ADMIN_TOKEN` | Re-queue failed jobs |

## How a message is handled

1. Signature verified on the raw body; payload normalized into the common model (`src/model/message.ts`).
2. Pause flag (Command Center) and **allowlist** checked. Anything else is dropped with a hashed-id audit entry.
3. Job written to the durable queue, then the webhook is acknowledged.
4. Media: streamed to disk with a size cap and SHA-256, validated by magic bytes/MIME/extension/structure.
5. Backend `upload-url`: same bytes already in R2 → `duplicate`; else a presigned PUT; file streamed to R2.
6. Backend registration (`Idempotency-Key`): it verifies the object in R2, stores message + media, records the
   true media outcome, and hands new messages to the existing report pipeline.

Media outcomes: `stored`, `duplicate`, `media_unavailable` (with reason), `rejected` (with reason),
`not_collected` (voice notes, stickers). A file is never reported as captured unless it is in R2.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — assessment of the existing system, diagram, data model
- [docs/CAPABILITIES.md](docs/CAPABILITIES.md) — WhatsApp/Viber capability matrix and limitations
- [docs/SECURITY.md](docs/SECURITY.md) — controls and residual risks
- [docs/TEST-PLAN.md](docs/TEST-PLAN.md) — test plan and results
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — deployment, health checks, restart, kill switches, rollback

## Known limitations

- Existing WhatsApp and Viber groups cannot be read by official APIs (stay with the Android bridge).
- Inbound media in API-created WhatsApp groups is not documented by Meta; must be confirmed with a real test.
- Viber: no groups; files from users to bots are documented as unsupported; bots need commercial terms.
- No text extraction from PDF/DOCX into the AI pipeline yet (documents are stored and linked; the report uses the
  message text/caption). Thumbnails are not generated; originals are shown through signed URLs.
- WhatsApp/Viber may compress photos and videos before the API delivers them.
- Viber retries a failed callback at most 10 times (increasing intervals, up to 900 s apart): a long collector outage can lose Viber messages.
