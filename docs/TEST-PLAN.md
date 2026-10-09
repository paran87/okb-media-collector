# Test plan and results

Two levels:

- **Automated (done):** `npm test` — unit tests plus end-to-end tests that run the real collector against the
  real `okb-bridge-cloud-backend` code (in-memory storage), a local R2 stand-in (presigned PUT/HEAD) and local
  fakes of the WhatsApp Graph/Media API and Viber Bot API built from the documented payloads. Webhooks are
  signed exactly as the platforms sign them.
- **Real authorized accounts (NOT done yet — Phase 18):** the same cases with a real WhatsApp Business number /
  Official Business Account and a real Viber bot, in a test deployment. Only these prove what the platforms
  actually deliver (notably: whether photos/documents posted in an API-created WhatsApp group reach the webhook).

Result of the automated run on 9 October 2026 (after the security fixes): **39 / 39 passed** (collector) and
**12 / 12 passed** (backend `test/collector.test.js`). The backend's full suite: 124 pass, and the same 36
pre-existing failures as `main` (see its README); consolidated-report tests 45 / 45.

| # | Test | Expected result | Actual (automated) | Pass/fail | Real account |
|---|---|---|---|---|---|
| 1 | Authorized WhatsApp group text | Message stored with group id, allowlist group name, sender id/name, message id, timestamp; report created by the existing pipeline; ingestion `none` | As expected | Pass | Pending |
| 2 | Authorized WhatsApp group photo | Original bytes in R2 at `whatsapp/YYYY/MM/DD/<uuid>-<name>.jpg`, same SHA-256, streamed with Content-Length; media linked to the report; ingestion `stored` | As expected | Pass | **Pending — group media not documented by Meta** |
| 3 | Authorized WhatsApp PDF | Stored unchanged; original filename recorded; key ends in the sanitized name | As expected | Pass | Pending |
| 4 | Authorized WhatsApp DOCX | Stored unchanged (OOXML structure checked, no macros) | As expected | Pass | Pending |
| 5 | Unauthorized WhatsApp group (and unlisted 1:1 sender) | Webhook 200; media **not downloaded**; nothing stored, uploaded or forwarded; audit entry with hashed ids only, no text | As expected | Pass | Pending |
| 6 | Authorized Viber text (1:1 with bot) | Stored; 64-bit message token preserved | As expected | Pass | Pending |
| 7 | Authorized Viber photo | Stored in R2 under `viber/…` | As expected | Pass | Pending |
| 8 | Authorized Viber PDF | Stored if Viber delivers a `file` message (Viber docs say user→bot files are not supported) | Stored (fake platform delivers it) | Pass (collector) | **Pending — likely unsupported by Viber** |
| — | Viber groups | `VIBER_MEDIA_CAPTURE_UNSUPPORTED` in health; unlisted senders ignored | As expected | Pass | n/a |
| 9 | Duplicate media + webhook redelivery | Same bytes stored once (second message `duplicate`, same R2 key); redelivered webhook not downloaded or registered again | As expected | Pass | Pending |
| 10 | R2 failure | Upload retried with backoff, then stored once | 2 failures, then stored | Pass | Pending |
| 11 | Backend failure | Webhook acknowledged after the job is on disk; retried until the backend is back; nothing lost; health `okbBackend: error` meanwhile | As expected | Pass | Pending |
| 12 | Restart with pending queue | Job and downloaded file survive restart; resumed without downloading again | As expected | Pass | Pending |
| 13 | Large file | Declared oversize: refused before download; undeclared: download aborted at the cap; message kept, media `rejected/size_limit_exceeded` | As expected | Pass | Pending |
| 14 | Malformed file / invalid MIME | EXE named `.pdf` → `unsupported_or_unrecognized_type`; truncated PDF → `malformed_file`; JPEG declared as PDF → `mime_type_mismatch`; nothing in R2 | As expected | Pass | Pending |
| 15 | Path traversal filename | `../../../etc/passwd/..\..\report.pdf` → key `whatsapp/…/<uuid>-report.pdf`, recorded name `report.pdf` | As expected | Pass | Pending |

Additional security / resilience tests (automated, all pass):

| Test | Expected | Result |
|---|---|---|
| Invalid / missing webhook signature (WhatsApp, Viber) | 401; nothing queued; audit `webhook_signature_invalid` | Pass |
| Meta verification handshake | Correct verify token → challenge; wrong → 403 | Pass |
| Oversized webhook body | 413 | Pass |
| Expired WhatsApp access token | Probe → health `auth_error`; downloads retried, then message registered as `media_unavailable` (text not lost) | Pass |
| Network timeout during download | Retried; then `media_unavailable (timeout)` | Pass |
| Platform reports unsupported message | `media_unavailable` with the platform's error code | Pass |
| Collector token rejected by backend (expired/wrong) | Health `okbBackend: auth_error`; job kept for retry; audit `backend_auth_failed` | Pass |
| Unauthorized request to ingestion endpoints | Missing, device, admin or wrong token → 401 (backend tests) | Pass |
| Forged object key / upload not in R2 / wrong size | 409/400; nothing stored (backend tests) | Pass |
| Pause from Command Center | Heartbeat delivers it; new messages ignored; backend answers 423 | Pass |
| Queue full | Webhook 503 (platform redelivers) | Pass |
| Validation corpus | ZIP slip, decompression bomb, encrypted ZIP, macro DOCX, plain ZIP, binary `.txt`, OLE without Office type, empty file → rejected | Pass |
| SSRF guard | http, foreign host, look-alike host, credentials in URL, private IPs → blocked | Pass |
| Secrets in logs | No token, secret or presigned signature in any log line or audit file across the runs; message text only as length | Pass |
| Longest multi-byte text (8000 chars, emoji) | Registered; truncation never splits a surrogate pair; request stays under the backend's 64 KB limit | Pass |
| Health honesty | `unknown` before the first real check; `connected` only after a successful API call; R2 `configured` until an upload succeeds | Pass |

## Running

```bash
npm ci
npm test                      # needs ../okb-bridge-cloud-backend (or OKB_BACKEND_DIR) with `npm install` done
```

## Local staging validation (9 October 2026) — simulated platforms, real storage stack

What was real: PostgreSQL 16 with the production schema from `okb-bridge-cloud-backend` `main` plus the new
migration; PostgREST 12 (the REST layer Supabase uses) with Supabase-style `anon`/`service_role` JWTs; the feature
branch backend using its **real** Supabase store; the collector service and its Docker image; the Command Center
(Next.js dev server) with the operator access key enabled. What was simulated: the WhatsApp Graph/Media API and the
Viber Bot API (local fakes), and R2 (a local stand-in for presigned PUT/HEAD/GET; R2 signatures not validated).

| Check | Result |
|---|---|
| Migration on a copy of the production schema: applied twice, existing rows untouched, constraints/FKs reject bad data, rollback removes only the 3 tables, re-apply after rollback | Pass (`okb-bridge-cloud-backend/migrations/test-local.sh`) |
| `anon` key through the REST API on `okb_ingested_media` | Refused (`permission denied`) — Pass |
| Android bridge contract: 33-step phone session (register, message, media intent/complete, report, schedule → automated TEXT claim/sent, TEST REPORT, PDF download + delivery, retry refusal, auth) on `main` vs branch | Identical except the additive `/health.mediaCollector` field (app parses with `ignoreUnknownKeys`) — Pass |
| WhatsApp group text / JPEG / PDF / DOCX, Viber text / JPEG / PDF | Stored; R2 objects byte-identical (SHA-256) to the source files — Pass (simulated) |
| Same PDF via WhatsApp and Viber | Second is `duplicate`, references the first object — Pass |
| Webhook redelivery | No second record — Pass |
| Unauthorized group | Not downloaded, no record — Pass |
| Oversized image, EXE named `.pdf`, `../../report.pdf` | `rejected` (size / type); recorded name `report.pdf` — Pass |
| Text already received by the Android bridge | Not stored twice; linked to the Android message — Pass |
| Backend restart, then the same registration replayed | `duplicate` (state reloaded from the database) — Pass |
| Docker image | Builds (Node 22, non-root, no runtime deps); `healthy`; refuses http backend in production (exit 2); job queued while backend down survives `docker stop` (exit 0) on the `/data` volume and is delivered by a new container — Pass |
| Command Center: access key required (wrong key refused), 401 for all media APIs without it, 403 cross-origin pause | Pass |
| Command Center: 8 files listed = database; filters source/type/status/group/sender/date match SQL counts; photos render; no overflow at 390 px | Pass |
| Signed links: 302 to R2 host, `X-Amz-Expires=600`, inline for View, attachment for Download, `Cache-Control: private, no-store`; rejected item → 404 | Pass (link shape only; real R2 expiry not exercised) |
| Open report link → the live report page of that message; Copy ref = `okb-media:<record id>` | Pass |
| Pause/Resume from Settings: written to the database with the operator name; backend answers 423 to the collector; nothing deleted; Android `/messages` and `run-due` still 201/200 | Pass |
| Defects found and fixed during this validation | Duplicate sign-in form on Settings; invented `media.jpg` original filename; device tokens accepted on collector admin routes when `OKB_ADMIN_TOKENS` is unset; weak collector tokens accepted |

## Real-account tests (Phase 18) — NOT RUN

Nothing below has been run. Fill the "Actual" column only from real messages sent from real phones to real
authorized accounts, on the **test** deployment. A simulated result never goes in this table.

Prerequisites: test Supabase project + migration; test backend with a dedicated `OKB_COLLECTOR_TOKENS` value; collector
test service on Render (HTTPS); a WhatsApp Business Platform test number (Meta's test number is fine for 1:1), and an
OBA number only if API-created groups are to be tested; a Viber bot (commercial terms) for Test B.

### Test A — WhatsApp (official)

| # | Step | Expected | Actual | Pass/fail |
|---|---|---|---|---|
| A1 | Meta App → WhatsApp → Configuration: webhook URL `https://<collector-test>/webhooks/whatsapp`, verify token; subscribe `messages` | Meta shows "verified"; collector audit `platform_connected`; `/health` whatsapp `connected` | NOT RUN | — |
| A2 | Send a text 1:1 from an allowlisted phone | Record `none`; message + report in backend | NOT RUN | — |
| A3 | Send a JPEG photo 1:1 | `stored`; R2 object; SHA-256 equals the media API's checksum | NOT RUN | — |
| A4 | Send a PDF 1:1 | `stored`, original filename kept | NOT RUN | — |
| A5 | Send a DOCX 1:1 | `stored` | NOT RUN | — |
| A6 | Record which webhook fields/types arrived (collector `LOG_LEVEL=debug`, test only) | Matches CAPABILITIES.md | NOT RUN | — |
| A7 | (OBA only) In an API-created group: text, JPEG, PDF | **Unknown**: record exactly what arrives; if no media webhook, mark unsupported | NOT RUN | — |
| A8 | Send from a non-allowlisted phone | Nothing stored; audit `unauthorized_conversation_ignored` | NOT RUN | — |
| A9 | Item visible in OKB Media; View/Download open the file; Open report works | As in staging | NOT RUN | — |
| A10 | `WHATSAPP_MEDIA_HOSTS` matches the real media URL host | No `media_url_blocked` | NOT RUN | — |

### Test B — Viber (official, 1:1 with the bot only)

| # | Step | Expected | Actual | Pass/fail |
|---|---|---|---|---|
| B1 | `npm run viber:set-webhook -- https://<collector-test>/webhooks/viber` | `status 0`; `/health` viber `connected`, "webhook is set" | NOT RUN | — |
| B2 | Allowlisted user sends text | Stored | NOT RUN | — |
| B3 | Sends a photo | `stored`; check `VIBER_MEDIA_HOSTS` against the real URL host | NOT RUN | — |
| B4 | Tries to send a PDF and a DOCX | **Expected not possible** (Viber docs); record what the app allows and what arrives | NOT RUN | — |
| B5 | Add the bot to an existing group | Expected impossible; record result | NOT RUN | — |

### Test C — storage and failure recovery (on the test deployment)

| # | Step | Expected | Actual | Pass/fail |
|---|---|---|---|---|
| C1 | Same message twice / same photo in two messages | One record per message; second photo `duplicate` | NOT RUN | — |
| C2 | Image above `MAX_IMAGE_SIZE_MB`; EXE renamed `.pdf` | `rejected` with reason | NOT RUN | — |
| C3 | Revoke the test backend's R2 key briefly (or point to a wrong bucket) | Uploads retried, `r2: error`; then stored after restore | NOT RUN | — |
| C4 | Suspend the test backend for 5 minutes | Collector queues, retries, delivers after resume | NOT RUN | — |
| C5 | Restart the collector service with jobs pending | Jobs resume from the disk | NOT RUN | — |
| C6 | Open a View link after 11 minutes | R2 refuses (expired) | NOT RUN | — |
| C7 | Call `/api/v1/media-ingestion` without/with a wrong token | 401 | NOT RUN | — |
