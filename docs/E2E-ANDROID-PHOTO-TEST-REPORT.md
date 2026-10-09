# End-to-end test report: WhatsApp group photo → Android bridge → backend → R2 → Supabase → Media page

Date: 9 October 2026 (runs between 01:20 and 02:00 UTC). Author: Claude Code session (cloud container, no phone).

Statuses used: **PASS** (verified end to end with actual components), **FAIL**, **BLOCKED** (an account,
permission or prerequisite is missing), **NOT RUN**. Anything run against stand-ins is labelled **SIMULATED** and is
not a real-account acceptance result.

## 1. Answer first

| Question | Answer |
|---|---|
| Can a photo sent to the existing ordinary WhatsApp group automatically reach the Command Center Media page? | **NO — not demonstrated, and not with the code as it was.** Two blockers: (1) the Android bridge only gets the photo bytes if WhatsApp attaches a readable content URI to the notification, which has never been observed on a real phone; (2) the Media page did not list Android-bridge uploads at all (fixed on the branches below). |
| Did the actual Android bridge obtain the original image bytes? | **BLOCKED** — no Android device or WhatsApp account is reachable from this environment. Code inspection: the only byte source is `MessagingStyle.Message.getDataUri()`; see §3. |
| Uploaded to the real staging R2 bucket? | **BLOCKED** — no R2 credentials and no staging bucket available. SIMULATED: byte-identical (SHA-256) in a local R2 stand-in. |
| Supabase record exists? | **BLOCKED** for the real project — the OKB tables are not in any Supabase project this session can reach. SIMULATED: verified in PostgreSQL 16 + PostgREST 12 with the production schema. |
| Appeared on the staging Media page without manual upload? | **BLOCKED** for staging. SIMULATED: appeared on the branch Media page, within 58 s without reload. |
| Duplicate photo / PDF / outage recovery | Real: **BLOCKED**. SIMULATED: all pass (§6). |
| Production ready? | **NO.** See §9. |

## 2. Environment and commits

| Repository | Inspected baseline | Result of this work (branch `claude/modest-hypatia-s8scna`) |
|---|---|---|
| `okb-whatsapp-bridge` (Android) | `claude/kind-hypatia-f630ty` @ `8238049` (app 1.5.3); `main` @ `e290d1a` | `3febdc8` (app 1.5.4), based on `8238049` |
| `okb-bridge-cloud-backend` | `main` @ `4d3e8e3`; collector work `claude/sleepy-maxwell-29rgpb` @ `90bf64a` | `eb10613`, based on `90bf64a` |
| `okb-website-repo` (Command Center) | `main` @ `cd601d8`; Media page `claude/sleepy-maxwell-29rgpb` @ `1743dbd` | `4bc2190`, based on `1743dbd` |
| `okb-media-collector` | `claude/modest-hypatia-s8scna` = `claude/sleepy-maxwell-29rgpb` @ `5fbf113` | this report (no code change) |

Nothing was merged into `main`, deployed, or written to any production Supabase/R2/Render/Vercel resource. The two
Supabase projects reachable from this session (`bragz`, `floodwatch`) contain no `okb_*` tables (read-only
`information_schema` query); the third is inactive. The production OKB Supabase project is therefore not reachable
here, which is also why nothing could have been modified in it.

What was used instead (all local, throwaway): PostgreSQL 16 with Supabase-style roles (`anon`, `authenticated`,
`service_role`, `authenticator`), the production schema from backend `origin/main`, plus both migrations; PostgREST
12.2.3 behind a `/rest/v1` proxy (what Supabase exposes); a local R2 stand-in (presigned PUT/HEAD/GET, bytes on
disk, switchable outage); the **real backend code** of `eb10613` with its **real Supabase store**; the **real
Command Center** of `4bc2190` (Next.js dev server, operator access key enabled); and a script that sends exactly the
requests of the Android app's `SyncMessagesUseCase` / `SyncMediaUseCase`. Harness: `docs/e2e-android-local/`.

## 3. Phase 2 — can the Android bridge obtain the photo bytes?

**Mechanism in the code (1.5.3 and 1.5.4):** `WhatsAppNotificationListenerService` → `NotificationSnapshotExtractor`
copies, per message of the notification's `MessagingStyle`, `dataUri` / `dataMimeType` → `AcquireMediaUseCase`
opens that URI with `ContentResolver.openInputStream` (no storage permission), streams it to app storage and hashes
it. Without a URI the media row is `UNAVAILABLE` with a reason; the caption/text is still captured and uploaded.

| Question | Finding |
|---|---|
| Receives only notification text/metadata? | For a photo: sender, group, time, "📷 Photo"/caption, and a `hasPicture` flag. That is metadata, not the file. |
| Attachment via an Android-supported mechanism? | Only `MessagingStyle.Message.setData(mime, uri)` set by WhatsApp. Android grants a notification listener read access to such URIs only if WhatsApp's provider allows it. `EXTRA_PICTURE` / large icons are downscaled bitmaps and are correctly **not** used. |
| Original bytes obtained? | **Unknown on real hardware.** No real-device evidence exists in any of the repositories (the bridge README itself expects "media unavailable" on most devices). Must be tested on the phone (§8, step 3). |
| Download via an already-authorized mechanism? | No. The bridge never downloads from WhatsApp and must not. |
| Upload without manual intervention? | Yes, **once bytes exist**: WorkManager drains the Room media queue (`intent → PUT → complete`) automatically, with retries. |

**Precise limitation:** WhatsApp decides whether a group notification carries a content URI. If it does not, no
supported Android API gives a notification listener the photo. Defect found and fixed in 1.5.4: WhatsApp notifies
before the photo has downloaded and re-posts the conversation later; the re-post was discarded as a duplicate, so a
URI that only appeared then was never read (§7, D3).

**Also important for the hash test:** WhatsApp re-encodes photos sent the normal way. The file the recipient phone
holds is not byte-identical to the sender's original. A SHA-256 match "original ↔ captured" is only possible when the
picture is sent **as a document**; for normal photos compare with the copy in the receiving phone's WhatsApp media
folder.

**Closest permitted fully automatic alternative (needs your approval before it is built):** a one-time Storage
Access Framework grant. On the bridge phone, the operator picks WhatsApp's shared media folder
(`Android/media/com.whatsapp/WhatsApp/Media`) once in the system folder picker (`ACTION_OPEN_DOCUMENT_TREE`); the app
keeps the persistable read permission. When an authorized-group photo/document notification arrives without a usable
URI, the bridge looks for the file WhatsApp saved in that folder in the following minutes and uploads it. One-time
setup, then automatic; no root, no accessibility scraping, no private APIs. Requirements and risks:

- WhatsApp media auto-download must be on for the bridge phone (photos, and documents for PDFs).
- Attribution: the folder holds files from **all** chats. Documents can be matched by file name (shown in the
  notification); photos (`IMG-YYYYMMDD-WA####.jpg`) only by time. To avoid attaching a private photo to an OKB report,
  a photo should be taken only when exactly one authorized-group photo notification and no other chat's photo arrived
  in the window; otherwise it stays "unavailable". This works reliably only on a **dedicated bridge phone/number**.
- Whether the system picker allows `Android/media` must be confirmed on the actual phone/Android version.

If none of this is acceptable, the remaining reliable alternative is the OKB Media Collector with the official
WhatsApp Cloud API — but that **cannot** read the existing ordinary group (`docs/CAPABILITIES.md`); reporters would
send to the OKB business number or an API-created group instead.

## 4. Architecture map (actual code paths)

| Step | Component | Actual implementation |
|---|---|---|
| A | WhatsApp group | Existing ordinary group; read only through the phone's notifications |
| B | Android bridge | `service/WhatsAppNotificationListenerService` → `ProcessNotificationUseCase` (filter, allowlisted source group, Room `messages`) → `AcquireMediaUseCase` (Room `media`, file in app storage) → WorkManager → `SyncMessagesUseCase` (`POST /api/v1/messages`) and `SyncMediaUseCase` |
| C | Backend `okb-bridge-cloud-backend` (Render service `okb-bridge-api`) | Device token + `X-OKB-Device-Id`; `POST /api/v1/devices/register`, `POST /api/v1/messages`, `POST /api/v1/media/intent` (content-addressed key `whatsapp/<deviceId>/YYYY/MM/DD/<sha256>.<ext>`, duplicate verdict or presigned PUT), `POST /api/v1/media/complete` |
| D | Cloudflare R2 | Bucket from `R2_BUCKET_NAME`; the phone PUTs directly with a 15-minute presigned URL; credentials stay on the backend |
| E | Supabase | `okb_bridge_messages`, `okb_bridge_media`, `okb_bridge_media_links` (one link per message using a file); view `okb_bridge_media_items` (new). The collector path uses `/api/v1/media-ingestion*` → `okb_ingested_media` — a different route and table |
| F | Command Center | `/command/media` → `GET /api/media-collector` (operator access key) → Supabase REST with the service-role key, server side; files via `/api/media-collector/<ref>/file` → 302 to a 10-minute signed R2 GET. Only on the unmerged branches |

The collector does **not** sit between the phone and the backend: it is a separate intake for the official APIs and
does nothing for photos the Android app never captured.

## 5. Real-account acceptance tests

| ID | Test | Status | Failing / missing component |
|---|---|---|---|
| 1 | New WhatsApp group photo | **BLOCKED** | No phone, WhatsApp test group, staging backend, staging R2 bucket or reachable OKB Supabase project in this environment |
| 2 | Duplicate photo and redelivery | **BLOCKED** | Same |
| 3 | PDF attachment | **BLOCKED** | Same; additionally depends on WhatsApp attaching a document URI to the notification (unverified) |
| 4 | Backend outage and recovery | **BLOCKED** | Same; must only be run against a staging backend |
| 5 | Invalid / inaccessible attachment | **BLOCKED** | Same |

No real-account result is claimed anywhere in this report.

## 6. SIMULATED results (local staging stack, 9 Oct 2026 01:46 UTC)

Test files: a harmless 241,542-byte JPEG (`sha256 64318a3c…ee52`) and a hand-built 590-byte PDF (`sha256
afe79c43…a595`). Device `OKB-ANDROID-E2E001`, group "OKB E2E Test Group". 21/21 checks passed
(`phone-sim.mjs`); the polling check passed separately.

| ID | Check | Result | Evidence |
|---|---|---|---|
| T1 | Message + media accepted | PASS (SIMULATED) | messages 201; intent `upload`; PUT 200; complete 201 `stored` |
| T1 | R2 object identical | PASS (SIMULATED) | key `whatsapp/OKB-ANDROID-E2E001/2026/10/09/64318a3c…ee52.jpg`; SHA-256 and size (241,542) equal to the original |
| T1 | Supabase rows | PASS (SIMULATED) | one `okb_bridge_media` row (sha, size, `image/jpeg`, `r2`), one link to the message |
| T1 | Media page lists it | PASS (SIMULATED) | item `stored`, `android_bridge`, size/sha/group/sender match; preview link signed |
| T1 | View/Download | PASS (SIMULATED) | 302 to a signed link for the same key, `X-Amz-Expires=600`, `attachment`; 401 without operator access |
| T1 | Refresh creates nothing | PASS (SIMULATED) | rows before/after two page loads: 1/1 → 1/1 |
| T1 | No public access | PASS (SIMULATED) | anon key: view → 401 (permission denied); `okb_bridge_media` → 0 rows (RLS) |
| T1 | Appears without reload | PASS (SIMULATED) | open page at 390 px; new upload; card count 7 → 8 after 58 s (60 s polling, also on focus) |
| T2 | Redelivery of the same event | PASS (SIMULATED) | complete again → 200 `duplicate`; message again → `duplicate`; still one link |
| T2 | Same bytes, distinct message | PASS (SIMULATED) | intent `duplicate`, no PUT, one R2 object, one media row, its own link; page shows "Duplicate" with the second sender |
| T2 | Concurrent identical uploads | PASS (SIMULATED) | completes 201 + 200; one intact object (hash ok), one media row, both messages linked |
| T3 | PDF | PASS (SIMULATED) | stored byte-identical as `….pdf`; page: kind document, `application/pdf`, 590 bytes; download sets `application/pdf` + filename |
| T4 | Backend down | PASS (SIMULATED) | requests fail (`ECONNREFUSED`); the phone keeps the job in Room (Android tests `SyncMediaUseCaseTest`, `BackgroundPipelineTest`) |
| T4 | After restart | PASS (SIMULATED) | backend reloads state from Supabase; delivered once (201), retry and earlier photo → `duplicate` |
| T5 | Complete without the file | PASS (SIMULATED) | 409 `object not found in storage…`; no media row (was 201 before fix D2) |
| T5 | R2 outage | PASS (SIMULATED) | PUT 503, complete 502 (phone retries), no row; after recovery stored once |
| T5 | Page shows nothing broken | PASS (SIMULATED) | never-stored photo not listed |

Durable queue ownership: the **Android bridge** (Room `media` + `media_upload_queue`, WorkManager) for anything the
phone captured; the backend has no queue. A photo the phone never captured cannot be recovered by any component.

UI check (CLAUDE.md): Media page at 390 px — no horizontal scroll (`scrollWidth` 390), action buttons 40 px high;
1280 px also checked. Thumbnails do not render in the local stack only because preview links are signed for the real
R2 host.

## 7. Defects found and fixed

| # | Earliest failing stage | Defect | Fix | Regression test |
|---|---|---|---|---|
| D1 | F — Media page | The Media page read only `okb_ingested_media` (collector). Android-bridge uploads go to `okb_bridge_media` and could **never** appear. | Read-only view `okb_bridge_media_items` (backend `eb10613`, migration `20261010_okb_bridge_media_items.sql`); page merges both sources, "Duplicate" per message, file route `b-<media id>` (website `4bc2190`) | `migrations/verify_okb_bridge_media_items.sql` via `test-local.sh`; SIMULATED T1–T3 |
| D2 | C — backend | `POST /api/v1/media/complete` recorded a file without checking R2: a valid-looking record could exist for a file never stored | Presigned HEAD before recording: missing or wrong size → 409, R2 unreachable → 502 (retryable) | `test/device-media.test.js` (3 of 4 fail without the fix) |
| D3 | B — Android | A content URI that appears only on WhatsApp's re-post of the conversation was ignored (duplicate message), leaving the photo `UNAVAILABLE` | Re-acquire when a duplicate media message now has a URI and its media row ended without a file; never for deleted messages (`3febdc8`, 1.5.4, no schema change) | `MediaCaptureTest` (3 new; the main one fails without the fix) |
| — | F — refresh | Media list refreshed every 5 minutes | Every 60 s (and on focus) | SIMULATED polling check |

## 8. Regression results

| Suite | Result |
|---|---|
| Android unit tests (`./gradlew testDebugUnitTest`, Robolectric, SDK 35) | 1.5.3 baseline: 277 tests, 276 pass, 2 skipped, 1 environment failure (Robolectric artifact download rate-limited). 1.5.4: **280 tests, 0 failures, 2 skipped**. `assembleDebug` builds. |
| Backend `node --test` | Branch: 164 tests, 128 pass, 36 fail; `main`: 148 tests, 112 pass, 36 fail — **the failing test names are identical** (pre-existing, stale local-sink/report tests). New `device-media.test.js` 4/4, `collector.test.js` 12/12. |
| Collector `npm test` (against the backend branch) | 39/39 |
| Website | `npx tsc --noEmit` clean; `eslint` + `prettier --check` clean on changed files |
| Migrations | `migrations/test-local.sh`: collector migration and the new view applied twice, verified, rolled back, re-applied |
| Android API contract | Unchanged requests and responses; `media/complete` adds 409/502 only for an object that is not in R2 (the app marks a 409 FAILED and its 15-minute reconciliation re-does intent → PUT → complete, up to 20 attempts; a 5xx is retried with back-off) |

Untouched: registration/device auth, text ingestion, flood-report extraction, consolidated reports, the report
schedule, automated WhatsApp sending, PDF generation, existing Command Center pages and access controls.

## 9. Production readiness

**NO-GO.** Required before a GO: (a) a real phone test showing the bridge obtains the bytes (§10 step 3) — or an
approved alternative (§3) built and tested; (b) real staging R2 + Supabase checks of T1–T5; (c) the Media page
verified on a staging deployment.

## 10. What you need to do (in order)

1. **Staging resources** (none exist that this session can reach): a Supabase project for staging with
   `supabase-schema.sql` from backend `main` plus `migrations/20261009_okb_media_collector.sql` and
   `migrations/20261010_okb_bridge_media_items.sql`; an R2 bucket for staging with a token scoped to it; a staging
   Render service (free plan) from backend `claude/modest-hypatia-s8scna` with those values; a Vercel preview of the
   website branch with `OKB_BRIDGE_SUPABASE_*`, `OPERATIONS_R2_*` (staging bucket) and `OKB_REPORTS_ACCESS_KEY`.
2. A **dedicated test phone** with the debug build of 1.5.4 (`./gradlew assembleDebug` on the bridge branch), pointed
   at the staging backend, and a **dedicated WhatsApp test group** of authorized people; auto-download of photos and
   documents on.
3. **Phase 2 probe (5 minutes, decisive):** send (a) a harmless photo, (b) the same photo *as a document*, (c) a
   small PDF, then a short text a minute later (forces a re-post). In the bridge app open each message's media:
   - `Available`/`Uploaded` → bytes obtained; continue with T1–T5 and compare hashes (use (b) for an exact match);
   - "WhatsApp did not attach the original file to the notification" → no URI: notification capture cannot work on
     this phone; decide on the §3 alternative;
   - "Android did not provide an accessible media file" → a URI exists but is not readable: report it, the §3
     alternative still applies.
4. Approve (or reject) the §3 folder-access design if step 3 shows no usable URI.
5. Apply the view migration to production only after staging passes, then merge in the order backend → website.
