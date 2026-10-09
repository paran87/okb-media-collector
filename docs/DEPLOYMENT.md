# Deployment, health checks, restart and rollback

The collector is deployed **independently** of the backend and the Android bridge. Order matters:
**schema → backend → collector → platform webhooks**.

## 1. Database (Supabase) — additive

Run the section **"OKB Media Collector"** at the end of `okb-bridge-cloud-backend/supabase-schema.sql` in the
Supabase SQL editor of the project in the backend's `SUPABASE_URL`. It only creates
`okb_ingested_media`, `okb_collector_status`, `okb_collector_settings` (RLS on) and is safe to re-run. Until it is
applied the backend answers 503 on the collector routes and everything else works as before.

## 2. Backend (okb-bridge-cloud-backend)

1. Generate a token: `openssl rand -base64 36`.
2. Set `OKB_COLLECTOR_TOKENS=<token>` on the Render service (must differ from device/admin tokens — the backend
   refuses to start otherwise). Optional: `OKB_COLLECTOR_MAX_MEDIA_BYTES` (default 200 MiB).
3. Deploy the backend version that contains `lib/collector/`. Check `GET /api/v1/health` →
   `"mediaCollector":"available"`.

No R2 change is needed: objects go to the existing bucket under new prefixes `whatsapp/YYYY/MM/DD/` and
`viber/YYYY/MM/DD/` (the Android bridge keeps `whatsapp/OKB-ANDROID-…/`).

## 3. Collector

Where: it needs a **persistent disk** (durable queue) and a **public HTTPS URL** (webhooks).

| Option | Notes |
|---|---|
| **Render (recommended, like the backend)** | `render.yaml` (Docker, Starter plan + 5 GB disk at `/data`). Render Free has no disk and sleeps: not suitable. |
| VPS + Docker | `docker compose up -d` behind an HTTPS reverse proxy (Caddy/nginx) with a trusted certificate. |
| Local development | `npm ci && npm run build && node dist/src/index.js` with a `.env` exported in the shell; expose with a tunnel for webhooks. |

Steps:
1. Copy `.env.example` values into the service's environment (secrets via the host's secret store, never in git).
2. Keep `WHATSAPP_ENABLED=false` / `VIBER_ENABLED=false` for the first deploy; check `/health`
   (`okbBackend.status` becomes `connected` after the first heartbeat).
3. Enable one platform with its allowlist; redeploy.

### WhatsApp (Meta App Dashboard)
- WhatsApp → Configuration → Webhook: callback `https://<collector>/webhooks/whatsapp`, verify token =
  `WHATSAPP_VERIFY_TOKEN`; subscribe to `messages` (and `group_lifecycle_update`, `group_participants_update`,
  `group_settings_update`, `group_status_update` if API-created groups are used).
- Use a System User access token (long-lived) in `WHATSAPP_ACCESS_TOKEN`; `WHATSAPP_APP_SECRET` = App Secret.

### Viber
- `VIBER_AUTH_TOKEN=… npm run viber:set-webhook -- https://<collector>/webhooks/viber` (collector must be running).

## Health checks

- `GET /health` (public, no ids/content): `status` `ok|degraded`; `whatsapp`/`viber`: `disabled`, `unknown` (not
  checked yet), `connected` (credentials verified by a live API call), `auth_error`, `unreachable`, `error`,
  `paused`; `groupCapture` codes; `r2`: `connected` (last upload OK) / `configured` / `error`; `okbBackend`;
  `queue.pending/failed`. Render uses it as `healthCheckPath`; Docker has a `HEALTHCHECK`.
- `GET /metrics` with `Authorization: Bearer $METRICS_TOKEN` (Prometheus text).
- Command Center → Settings → OKB Media Collector shows the last heartbeat (stale after 3 minutes = offline).

## Restart

- Render: Manual Deploy → "Restart service". Docker: `docker compose restart`.
- SIGTERM is a graceful stop: webhooks stop, running jobs are saved, the queue stays on `/data` and resumes on start.
  Platforms redeliver webhooks that were not acknowledged while it was down (Meta retries for days; Viber at
  most 10 times with intervals up to 900 s — a long outage can lose Viber callbacks).
- Failed jobs (retries exhausted): `curl -X POST -H "Authorization: Bearer $COLLECTOR_ADMIN_TOKEN" https://<collector>/admin/queue/retry-failed`.

## Kill switches

| Need | Action | Effect |
|---|---|---|
| Stop one platform now, from the Command Center | Settings → OKB Media Collector → Pause | Within one heartbeat (≤ 60 s) new messages are ignored; backend refuses that platform (423) |
| Stop one platform for good | `WHATSAPP_ENABLED=false` / `VIBER_ENABLED=false`, redeploy | Webhook route disappears (404) |
| Stop everything | Suspend the Render service / `docker compose stop` | Nothing is received |
| Revoke access | Remove the token from `OKB_COLLECTOR_TOKENS`; rotate platform tokens; remove the webhook in Meta / `viber:set-webhook -- --remove` | Collector can no longer write |

## Rollback

- **Collector:** redeploy the previous image/commit (Render: "Rollback" on a previous deploy). The queue format is
  versionless JSON; pending jobs are kept. To remove the component completely: remove the webhooks, suspend the
  service, remove the collector token from the backend.
- **Backend:** redeploy the previous commit. The new routes disappear; existing data stays. Collector messages
  already stored are normal `okb_bridge_messages`/`okb_bridge_media` rows and keep working in reports.
- **Database:** the new tables can stay (unused) or be dropped:
  `drop table okb_ingested_media, okb_collector_status, okb_collector_settings;` — no existing table was altered.
- **Command Center:** revert the commit; the page and settings card disappear. Nothing else depends on them.

## Production gate (Phase 20)

Do not enable a platform in production until the Phase 18 checklist in [TEST-PLAN.md](TEST-PLAN.md) has been run
with real authorized accounts and its results are recorded.
