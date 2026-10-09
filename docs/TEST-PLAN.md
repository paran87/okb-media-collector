# Test plan and results

Two levels:

- **Automated (done):** `npm test` — unit tests plus end-to-end tests that run the real collector against the
  real `okb-bridge-cloud-backend` code (in-memory storage), a local R2 stand-in (presigned PUT/HEAD) and local
  fakes of the WhatsApp Graph/Media API and Viber Bot API built from the documented payloads. Webhooks are
  signed exactly as the platforms sign them.
- **Real authorized accounts (NOT done yet — Phase 18):** the same cases with a real WhatsApp Business number /
  Official Business Account and a real Viber bot, in a test deployment. Only these prove what the platforms
  actually deliver (notably: whether photos/documents posted in an API-created WhatsApp group reach the webhook).

Result of the automated run on 9 October 2026: **38 / 38 passed** (collector) and **11 / 11 passed**
(backend `test/collector.test.js`; the backend's full suite is unchanged at 123 pass / 36 pre-existing failures,
see its README).

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

## Phase 18 checklist (real accounts, test deployment)

1. Deploy backend branch + schema section to a **test** Supabase/R2 (or the production bucket with a test prefix),
   collector to a test host with HTTPS.
2. WhatsApp: test number, webhook subscribed to `messages` (and the four group fields if groups are used).
   Allowlist only the test group / test sender. Run TEST 1–5, 9, 13–15 by sending real messages.
3. Viber: test bot, `npm run viber:set-webhook -- https://<host>/webhooks/viber`, allowlist the tester's id
   (visible as `senderRef` hash only — get the id from the first `unauthorized_conversation_ignored` audit entry
   by temporarily setting `LOG_LEVEL=debug`, or from Viber's `conversation_started` event). Run TEST 6–8.
4. Confirm `VIBER_MEDIA_HOSTS` / `WHATSAPP_MEDIA_HOSTS` match the real media URLs (a mismatch shows as
   `media_unavailable (media_url_blocked)`).
5. Record the actual results in this table (Real account column) before production.
