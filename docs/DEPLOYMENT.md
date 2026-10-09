# Deployment, health checks, restart and rollback

The collector is deployed **independently** of the backend and the Android bridge. Order matters:
**schema → backend → collector → platform webhooks**.

## 1. Database (Supabase) — additive

Use `okb-bridge-cloud-backend/migrations/20261009_okb_media_collector.sql` (one transaction; never paste the whole
`supabase-schema.sql`). It creates `okb_ingested_media`, `okb_collector_status`, `okb_collector_settings`, enables RLS
and revokes all privileges from `anon`/`authenticated`. It alters, drops or writes no existing table or row and is
safe to re-run. Validated on PostgreSQL 16 against the `main` schema (`migrations/test-local.sh`); Supabase runs 17.

Order: **test project first.** Before production: Database → Backups (confirm a recent backup), then run the file in
the SQL editor, then check Advisors → Security. Rollback: `20261009_okb_media_collector_rollback.sql`.
Until the migration is applied the backend's collector routes answer 503 and everything else works as before.

## 2. Backend (okb-bridge-cloud-backend)

1. Generate a token: `openssl rand -base64 36`.
2. Set `OKB_COLLECTOR_TOKENS=<token>` on the Render service: at least 32 characters (shorter ones are ignored),
   different from device/admin tokens (the backend refuses to start otherwise). To rotate, list the new and old token
   (`new,old`), update the collector, then remove the old one. `OKB_ADMIN_TOKENS` must be set for the Command Center's
   collector status/pause (device tokens are never accepted there). Optional: `OKB_COLLECTOR_MAX_MEDIA_BYTES` (default 200 MiB).
3. Deploy the backend version that contains `lib/collector/`. Check `GET /api/v1/health` →
   `"mediaCollector":"available"`.

No R2 change is needed: objects go to the existing bucket under new prefixes `whatsapp/YYYY/MM/DD/` and
`viber/YYYY/MM/DD/` (the Android bridge keeps `whatsapp/OKB-ANDROID-…/`).

## 3. Collector

### Test service on Render (recommended first deployment)

The collector needs a persistent disk (its queue and staged files live in `DATA_DIR`), so it needs a **paid**
instance: Render's free web services cannot attach disks and sleep when idle. Verified price points (Oct 2026):
Starter instance $7/month, disks $0.25/GB/month → about **$8.25/month** with a 5 GB disk.

1. Render dashboard → **New → Web Service** → repository `paran87/okb-media-collector`, branch
   `claude/sleepy-maxwell-29rgpb`, name `okb-media-collector-test`, region near the backend (Singapore if the
   backend is there).
2. Runtime **Docker** (the repository's `Dockerfile`; Node 22 Alpine, runs as non-root `node`). Instance type
   **Starter**. Auto-deploy off.
3. **Disks → Add disk**: mount path `/data`, 5 GB. (`DATA_DIR=/data` is already set in the image.)
4. Health check path: `/health`.
5. Environment (Dashboard → Environment, never in git): `OKB_BACKEND_URL` (the **test** backend's https URL),
   `OKB_COLLECTOR_TOKEN` (a dedicated test token, ≥ 32 characters, also listed in the test backend's
   `OKB_COLLECTOR_TOKENS`), `COLLECTOR_ID=okb-media-collector-test`, `METRICS_TOKEN`, `COLLECTOR_ADMIN_TOKEN`; keep
   `WHATSAPP_ENABLED=false` and `VIBER_ENABLED=false` for the first deploy.
6. Deploy → `GET https://okb-media-collector-test.onrender.com/health`: `okbBackend.status` becomes `connected` within
   a minute (first heartbeat); `queue` is empty.
7. Enable one platform with its credentials and allowlist; redeploy; run Test A / Test B in TEST-PLAN.md.

Render sends SIGTERM on every deploy/restart; the collector stops accepting webhooks, saves running jobs and exits
(forced after 25 s, within Render's 30 s). A service with a disk runs one instance, so each deploy has a short gap;
WhatsApp redelivers webhooks it could not deliver.

`render.yaml` describes the same service for a Blueprint (production name, no branch pinned).

### Other hosts

| Option | Notes |
|---|---|
| VPS + Docker | `docker compose up -d` behind an HTTPS reverse proxy (Caddy/nginx) with a trusted certificate. Image build and container restart recovery verified locally. |
| Local development | `npm ci && npm run build && node dist/src/index.js` with a `.env` exported in the shell; expose with a tunnel for webhooks. |

### Platform setup

WhatsApp (Meta App Dashboard): WhatsApp → Configuration → Webhook: callback `https://<collector>/webhooks/whatsapp`,
verify token = `WHATSAPP_VERIFY_TOKEN`; subscribe to `messages` (and `group_lifecycle_update`,
`group_participants_update`, `group_settings_update`, `group_status_update` only if API-created groups are used).
Use a System User access token; `WHATSAPP_APP_SECRET` = App Secret.

Viber: `VIBER_AUTH_TOKEN=… npm run viber:set-webhook -- https://<collector>/webhooks/viber` (collector running).

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
- **Database:** the new tables can stay (unused) or be removed with
  `okb-bridge-cloud-backend/migrations/20261009_okb_media_collector_rollback.sql` (drops only those three tables;
  collected messages/files stay in the existing tables and R2). No existing table was altered.
- **Command Center:** revert the commit; the page and settings card disappear. Nothing else depends on them.

## Production gate (Phase 20)

Do not enable a platform in production until the Phase 18 checklist in [TEST-PLAN.md](TEST-PLAN.md) has been run
with real authorized accounts and its results are recorded.
