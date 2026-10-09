# Security and compliance

## Platform compliance
- Only official APIs: WhatsApp Business Platform (Cloud API webhooks + Media API) and Viber REST Bot API.
- No WhatsApp/Viber client is modified, automated or impersonated; no traffic interception, no access to another
  app's files, no credential/cookie extraction. `WHATSAPP_MODE`/`VIBER_MODE` other than `official` are refused.
- The Android bridge is a separate component and was not changed.

## Authorization of what is collected
- Explicit allowlists of **stable platform ids** (`WHATSAPP_ALLOWED_GROUP_IDS`, `WHATSAPP_ALLOWED_SENDER_IDS`,
  `VIBER_ALLOWED_SENDER_IDS`). Enabling a platform with an empty allowlist is refused at startup.
- Names never authorize. Group capture on Viber is impossible (`group_capture_unsupported`).
- WhatsApp webhooks for other phone numbers of the same Meta app are ignored.
- Unauthorized messages: not queued, media not downloaded, nothing sent to R2/backend/AI; the audit log records only
  the reason and salted hashes of the ids.
- The Command Center can **pause** a platform; it cannot add groups or senders.

## Authentication
| Link | Mechanism |
|---|---|
| WhatsApp → collector | `X-Hub-Signature-256` HMAC-SHA256 of the raw body with the App Secret; GET verify token compared in constant time |
| Viber → collector | `X-Viber-Content-Signature` HMAC-SHA256 of the raw body with the bot token |
| Collector → backend | `Authorization: Bearer` collector token (separate token class; cannot use device/admin routes); HTTPS required in production; `Idempotency-Key` on writes |
| Collector → R2 | No R2 credentials: short-lived presigned PUT for one key + Content-Type, issued by the backend |
| Command Center → files | Operator access key gate; 10-minute signed GET URLs; private bucket |
| Collector admin/metrics | Separate bearer tokens; endpoints disabled (404) when unset |

## File handling
- Streamed to disk (never fully in memory), SHA-256 while streaming, aborted when the size limit is exceeded,
  declared size and platform checksum cross-checked.
- Type decided from magic bytes; declared MIME and extension must agree; OOXML central directory inspected
  (no extraction): ZIP slip names, encrypted entries, decompression-bomb ratios/sizes, `vbaProject.bin` macros
  rejected; PDF must have an EOF marker. Unsupported types (EXE, scripts, archives, audio) are not stored.
- Files are never opened, executed, converted or text-extracted; the original bytes in R2 are never modified.
- Filenames never form paths: the backend chooses `source/YYYY/MM/DD/<uuid>-<safe-name>.<detected-ext>`.
- Media downloads: https only, allowlisted hosts, no private/loopback addresses, redirects re-checked, auth headers
  not forwarded to other hosts.

## Data minimization and logs
- Collected per message: platform, group id/name, sender id/name, message id, timestamp, text, media metadata,
  storage key, checksum. Not collected: contact cards, reactions, address books, unrelated conversations.
- Logs: JSON, credential-named fields redacted, every configured secret value redacted (raw and URL-encoded),
  ids hashed, message text only as its length (`LOG_MESSAGE_CONTENT` refused in production).
- Queue files contain message text until registered; directory 0700, files 0600, deleted on completion.
- Health/metrics/heartbeat contain no ids, names or content.

## Residual risks
- A leaked collector token lets an attacker register fake messages (it cannot read data, change other routes, or
  choose R2 keys). Rotate via `OKB_COLLECTOR_TOKENS`.
- Viber media URLs are public for one hour (platform design).
- WhatsApp may compress photos/videos sent as media; only documents are guaranteed byte-identical to the sender's.
- Text extraction from documents for AI is not implemented (deliberately, see README "Known limitations").
