# Local staging stack for the Android-bridge photo path (SIMULATED)

Throwaway, local only. Never point it at a real Supabase project or R2 bucket.

- `stack.js` — `/rest/v1` proxy → PostgREST on :3001, a fake R2 on :9000 (bytes in `./r2`, outage switch on :9001
  `/r2?down=1|0`, backend switch `/backend?down=1|0`) and the real `okb-bridge-cloud-backend` (`OKB_BACKEND_DIR`) on
  :8095 with its real Supabase store.
- `phone-sim.mjs` — sends exactly the Android app's requests and checks R2 bytes, database rows (service role and
  anon) and the Command Center API (`http://localhost:3200`, cookie from `cookies.txt`).

Setup used on 9 Oct 2026: PostgreSQL 16 database `okb_staging` with the roles from `migrations/test-local.sh` plus an
`authenticator` login role; `supabase-schema.sql` from backend `origin/main`, then
`20261009_okb_media_collector.sql` and `20261010_okb_bridge_media_items.sql`; PostgREST 12.2.3 with a random JWT
secret; `service.jwt` / `anon.jwt` signed with it (roles `service_role` / `anon`); the website on :3200 with
`OKB_BRIDGE_SUPABASE_URL=http://127.0.0.1:54321`, `OKB_BRIDGE_SUPABASE_SERVICE_ROLE_KEY=<service.jwt>`,
`OKB_REPORTS_ACCESS_KEY`, `AUTH_SECRET`, dummy `OPERATIONS_R2_*`, signed in through `POST /api/reports/access`.
Put `test-photo.jpg` and `okb-e2e-test.pdf` (harmless files) next to the scripts, then run `node stack.js` and
`node phone-sim.mjs` (Playwright-free; Node 20+).
