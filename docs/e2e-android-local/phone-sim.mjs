// SIMULATED Android bridge client: issues exactly the requests SyncMessagesUseCase / SyncMediaUseCase send
// (register → messages → media/intent → PUT → media/complete) to the local staging backend, then checks the
// database (PostgREST, service role), the fake-R2 bytes and the Command Center API. Not a real phone.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const DIR = process.env.E2E_STACK_DIR || path.dirname(new URL(import.meta.url).pathname);
const API = 'http://127.0.0.1:8095', DB = 'http://127.0.0.1:54321/rest/v1', WEB = 'http://localhost:3200', CTL = 'http://127.0.0.1:9001';
const SVC = fs.readFileSync(path.join(DIR, 'service.jwt'), 'utf8'), ANON = fs.readFileSync(path.join(DIR, 'anon.jwt'), 'utf8');
const COOKIE = fs.readFileSync(path.join(DIR, 'cookies.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#') || l.startsWith('#HttpOnly_')).map((l) => l.split('\t')).filter((p) => p.length >= 7).map((p) => `${p[5]}=${p[6]}`).join('; ');
const DEVICE = 'OKB-ANDROID-E2E001';
const H = { Authorization: 'Bearer staging-device-token-0123456789', 'Content-Type': 'application/json', 'X-OKB-Device-Id': DEVICE };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const results = [];
const check = (id, name, ok, evidence) => { results.push({ id, name, ok: Boolean(ok), evidence }); console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name} :: ${JSON.stringify(evidence)}`); };
const post = (p, body) => fetch(API + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
const db = async (q, key = SVC) => { const r = await fetch(`${DB}/${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const r2file = (key) => path.join(DIR, 'r2', encodeURIComponent(key));
const web = (p) => fetch(WEB + p, { headers: { Cookie: COOKIE }, redirect: 'manual' });
const iso = (d) => d.toISOString().replace('Z', '+00:00');

async function sendMessage({ text, mediaType, group = 'OKB E2E Test Group', sender = 'E2E Tester', at }) {
  const fp = sha(`${group}|${sender}|${text}|${at.getTime()}|${crypto.randomUUID()}`);
  const r = await post('/api/v1/messages', {
    deviceId: DEVICE, clientMessageId: crypto.randomUUID(), fingerprint: fp, groupName: group, senderName: sender, messageText: text,
    timestamp: iso(at), timestampMillis: at.getTime(), mediaType, mediaStatus: 'AVAILABLE', sourcePackage: 'com.whatsapp', capturedAt: iso(at), platform: 'whatsapp',
  });
  return { fp, status: r.status, body: await r.json() };
}
async function uploadMedia({ bytes, fp, mediaType, mime, name, at, skipPut = false }) {
  const meta = { deviceId: DEVICE, sha256: sha(bytes), mediaType, mimeType: mime, fileSizeBytes: bytes.length, originalFileName: name, groupName: 'OKB E2E Test Group', capturedAt: iso(at), messageFingerprint: fp };
  const ir = await post('/api/v1/media/intent', meta); const intent = await ir.json();
  let put = null;
  if (intent.status === 'upload' && !skipPut) put = (await fetch(intent.uploadUrl, { method: 'PUT', headers: intent.headers, body: bytes })).status;
  const cr = await post('/api/v1/media/complete', { ...meta, objectKey: intent.objectKey, etag: 'local-etag', senderName: 'E2E Tester' });
  return { intentStatus: ir.status, intent: intent.status, objectKey: intent.objectKey, put, completeStatus: cr.status, complete: await cr.json() };
}
const count = async (q) => (await db(q)).body.length;

const now = new Date();
console.log('run at', now.toISOString());
await post('/api/v1/devices/register', { deviceId: DEVICE, deviceName: 'E2E simulated phone', platform: 'android', appVersion: '1.5.4', osVersion: '14', manufacturer: 'sim', model: 'sim' });

// ---- T1 photo ----
const photo = fs.readFileSync(path.join(DIR, 'test-photo.jpg'));
const m1 = await sendMessage({ text: 'E2E T1 photo', mediaType: 'IMAGE', at: now });
const u1 = await uploadMedia({ bytes: photo, fp: m1.fp, mediaType: 'IMAGE', mime: 'image/jpeg', name: null, at: now });
check('T1', 'backend stored message + media', m1.status === 201 && u1.completeStatus === 201 && u1.complete.status === 'stored', { message: m1.status, intent: u1.intent, put: u1.put, complete: u1.completeStatus });
const stored = fs.existsSync(r2file(u1.objectKey)) ? fs.readFileSync(r2file(u1.objectKey)) : null;
check('T1', 'R2 object bytes identical (SHA-256, size)', stored && sha(stored) === sha(photo) && stored.length === photo.length, { key: u1.objectKey, original: sha(photo), stored: stored && sha(stored), bytes: stored && stored.length });
const mediaRows = (await db(`okb_bridge_media?object_key=eq.${encodeURIComponent(u1.objectKey)}&select=id,sha256,file_size_bytes,mime_type,storage,group_name,sender_name`)).body;
check('T1', 'Supabase okb_bridge_media row', mediaRows.length === 1 && mediaRows[0].sha256 === sha(photo) && Number(mediaRows[0].file_size_bytes) === photo.length && mediaRows[0].mime_type === 'image/jpeg', mediaRows);
const links1 = await count(`okb_bridge_media_links?message_fingerprint=eq.${m1.fp}&select=media_id`);
check('T1', 'Supabase link to the message', links1 === 1, { links: links1 });
const page1 = await (await web('/api/media-collector')).json();
const item1 = page1.data.items.find((i) => i.messageText === 'E2E T1 photo');
check('T1', 'Media page API lists the photo', item1 && item1.status === 'stored' && item1.hasFile && item1.channel === 'android_bridge' && item1.fileSizeBytes === photo.length && item1.sha256 === sha(photo) && item1.groupName === 'OKB E2E Test Group', item1 && { id: item1.id, status: item1.status, kind: item1.kind, size: item1.fileSizeBytes, preview: Boolean(item1.previewUrl), group: item1.groupName, sender: item1.senderName });
const fr = await web(`/api/media-collector/${item1.fileRef}/file?download=1`);
const loc = fr.headers.get('location') || '';
const signedKey = decodeURIComponent(new URL(loc).pathname.split('/').slice(2).join('/'));
const exp = new URL(loc).searchParams.get('X-Amz-Expires');
check('T1', 'View/Download redirects to a signed link for the same object (10 min)', fr.status === 302 && signedKey === u1.objectKey && exp === '600' && loc.includes('X-Amz-Signature') && loc.includes('attachment'), { status: fr.status, keyMatches: signedKey === u1.objectKey, expiresSeconds: exp });
const noAuth = await fetch(`${WEB}/api/media-collector/${item1.fileRef}/file`, { redirect: 'manual' });
check('T1', 'file link refused without operator access', noAuth.status === 401, { status: noAuth.status });
const before = [await count('okb_bridge_media?select=id'), await count('okb_bridge_media_links?select=media_id')];
await web('/api/media-collector'); await web('/api/media-collector');
const after = [await count('okb_bridge_media?select=id'), await count('okb_bridge_media_links?select=media_id')];
check('T1', 'refreshing the page creates no record', before.join() === after.join(), { before, after });
const anon = await db('okb_bridge_media_items?select=media_id', ANON);
const anonMedia = await db('okb_bridge_media?select=id', ANON);
check('T1', 'anon key cannot read media metadata', anon.status >= 400 && (anonMedia.status >= 400 || (anonMedia.body || []).length === 0), { view: anon.status, table: anonMedia.status, rows: (anonMedia.body || []).length });

// ---- T2 duplicates ----
const redo = await post('/api/v1/media/complete', { deviceId: DEVICE, sha256: sha(photo), objectKey: u1.objectKey, etag: 'local-etag', fileSizeBytes: photo.length, mediaType: 'IMAGE', mimeType: 'image/jpeg', originalFileName: null, groupName: 'OKB E2E Test Group', senderName: 'E2E Tester', messageFingerprint: m1.fp, capturedAt: iso(now) });
const m1again = await post('/api/v1/messages', { deviceId: DEVICE, clientMessageId: crypto.randomUUID(), fingerprint: m1.fp, groupName: 'OKB E2E Test Group', senderName: 'E2E Tester', messageText: 'E2E T1 photo', timestamp: iso(now), timestampMillis: now.getTime(), mediaType: 'IMAGE', mediaStatus: 'AVAILABLE', sourcePackage: 'com.whatsapp', capturedAt: iso(now), platform: 'whatsapp' });
check('T2', 'redelivery of the same event: no new records', redo.status === 200 && (await redo.json()).status === 'duplicate' && (await m1again.json()).status === 'duplicate' && await count(`okb_bridge_media_links?message_fingerprint=eq.${m1.fp}`) === 1, { complete: redo.status, message: m1again.status });
const t2 = new Date(now.getTime() + 60_000);
const m2 = await sendMessage({ text: 'E2E T2 same photo again', mediaType: 'IMAGE', sender: 'Second Sender', at: t2 });
const u2 = await uploadMedia({ bytes: photo, fp: m2.fp, mediaType: 'IMAGE', mime: 'image/jpeg', name: null, at: now });
const r2count = fs.readdirSync(path.join(DIR, 'r2')).filter((f) => f.includes(sha(photo))).length;
check('T2', 'distinct message, same bytes: no second upload/object/media row, own link', u2.intent === 'duplicate' && u2.put === null && r2count === 1 && await count(`okb_bridge_media?sha256=eq.${sha(photo)}`) === 1 && await count(`okb_bridge_media_links?message_fingerprint=eq.${m2.fp}`) === 1, { intent: u2.intent, objects: r2count });
const page2 = await (await web('/api/media-collector')).json();
const item2 = page2.data.items.find((i) => i.messageText === 'E2E T2 same photo again');
check('T2', 'Media page keeps the second message metadata, marked duplicate', item2 && item2.status === 'duplicate' && item2.senderName === 'Second Sender' && item2.fileRef === item1.fileRef, item2 && { status: item2.status, sender: item2.senderName, sameFile: item2.fileRef === item1.fileRef });
// Concurrent uploads of new identical bytes from two messages.
const photoC = Buffer.concat([photo, Buffer.from('concurrent-variant')]);
const [ca, cb] = await Promise.all([sendMessage({ text: 'E2E T2 concurrent A', mediaType: 'IMAGE', at: t2 }), sendMessage({ text: 'E2E T2 concurrent B', mediaType: 'IMAGE', at: t2 })]);
const cr = await Promise.all([uploadMedia({ bytes: photoC, fp: ca.fp, mediaType: 'IMAGE', mime: 'image/jpeg', at: t2 }), uploadMedia({ bytes: photoC, fp: cb.fp, mediaType: 'IMAGE', mime: 'image/jpeg', at: t2 })]);
// A phone retries a failed complete (5xx) later; do that once for any non-2xx.
for (const [i, r] of cr.entries()) if (r.completeStatus >= 500) cr[i] = await uploadMedia({ bytes: photoC, fp: [ca, cb][i].fp, mediaType: 'IMAGE', mime: 'image/jpeg', at: t2 });
const cKey = cr[0].objectKey; const cStored = fs.readFileSync(r2file(cKey));
check('T2', 'concurrent duplicate uploads: one intact object, one media row, both linked', sha(cStored) === sha(photoC) && await count(`okb_bridge_media?sha256=eq.${sha(photoC)}`) === 1 && await count(`okb_bridge_media_links?message_fingerprint=in.(${ca.fp},${cb.fp})`) === 2, { completes: cr.map((r) => r.completeStatus) });

// ---- T3 PDF ----
const pdf = fs.readFileSync(path.join(DIR, 'okb-e2e-test.pdf'));
const m3 = await sendMessage({ text: '📄 okb-e2e-test.pdf', mediaType: 'DOCUMENT', at: new Date(now.getTime() + 120_000) });
const u3 = await uploadMedia({ bytes: pdf, fp: m3.fp, mediaType: 'DOCUMENT', mime: 'application/pdf', name: 'okb-e2e-test.pdf', at: now });
const pStored = fs.readFileSync(r2file(u3.objectKey));
check('T3', 'PDF stored byte-identical with MIME/size/name', u3.completeStatus === 201 && sha(pStored) === sha(pdf) && u3.objectKey.endsWith('.pdf'), { key: u3.objectKey, sha: sha(pStored) === sha(pdf), size: pStored.length });
const page3 = await (await web('/api/media-collector?kind=document')).json();
const item3 = page3.data.items.find((i) => i.fileName === 'okb-e2e-test.pdf');
const f3 = item3 && await web(`/api/media-collector/${item3.fileRef}/file?download=1`);
const l3 = f3 && new URL(f3.headers.get('location'));
check('T3', 'Media page lists the PDF; download link carries filename + application/pdf', item3 && item3.kind === 'document' && item3.mimeType === 'application/pdf' && item3.fileSizeBytes === pdf.length && f3.status === 302 && l3.searchParams.get('response-content-type') === 'application/pdf' && l3.searchParams.get('response-content-disposition').includes('okb-e2e-test.pdf'), item3 && { kind: item3.kind, mime: item3.mimeType, size: item3.fileSizeBytes, redirect: f3.status });

// ---- T4 backend outage ----
const t4 = new Date(now.getTime() + 180_000);
await fetch(`${CTL}/backend?down=1`);
const photo4 = Buffer.concat([photo, Buffer.from('t4-outage')]);
let outageErr = null;
try { await sendMessage({ text: 'E2E T4 outage', mediaType: 'IMAGE', at: t4 }); } catch (e) { outageErr = e.cause?.code || e.message; }
check('T4', 'backend down: request fails (phone keeps the job queued; see Android tests)', Boolean(outageErr), { error: outageErr });
await fetch(`${CTL}/backend?down=0`);
const m4 = await sendMessage({ text: 'E2E T4 outage', mediaType: 'IMAGE', at: t4 });
const u4 = await uploadMedia({ bytes: photo4, fp: m4.fp, mediaType: 'IMAGE', mime: 'image/jpeg', at: t4 });
const u4retry = await uploadMedia({ bytes: photo4, fp: m4.fp, mediaType: 'IMAGE', mime: 'image/jpeg', at: t4 });
const t1AfterRestart = await uploadMedia({ bytes: photo, fp: m1.fp, mediaType: 'IMAGE', mime: 'image/jpeg', at: now });
check('T4', 'after restart: delivered once, retries are duplicates, state reloaded from Supabase', m4.status === 201 && u4.completeStatus === 201 && u4retry.intent === 'duplicate' && t1AfterRestart.intent === 'duplicate' && await count(`okb_bridge_media?sha256=eq.${sha(photo4)}`) === 1 && await count(`okb_bridge_media_links?message_fingerprint=eq.${m4.fp}`) === 1, { message: m4.status, complete: u4.completeStatus, retry: u4retry.intent, earlierPhoto: t1AfterRestart.intent });

// ---- T5 inaccessible attachment ----
const photo5 = Buffer.concat([photo, Buffer.from('t5-never-uploaded')]);
const m5 = await sendMessage({ text: 'E2E T5 never uploaded', mediaType: 'IMAGE', at: new Date(now.getTime() + 240_000) });
const u5 = await uploadMedia({ bytes: photo5, fp: m5.fp, mediaType: 'IMAGE', mime: 'image/jpeg', at: now, skipPut: true });
check('T5', 'complete without the file in R2 is refused; no media row', u5.completeStatus === 409 && await count(`okb_bridge_media?sha256=eq.${sha(photo5)}`) === 0, { complete: u5.completeStatus, error: u5.complete.error });
await fetch(`${CTL}/r2?down=1`);
const photo6 = Buffer.concat([photo, Buffer.from('t5-r2-down')]);
const m6 = await sendMessage({ text: 'E2E T5 R2 down', mediaType: 'IMAGE', at: new Date(now.getTime() + 250_000) });
const u6 = await uploadMedia({ bytes: photo6, fp: m6.fp, mediaType: 'IMAGE', mime: 'image/jpeg', at: now });
await fetch(`${CTL}/r2?down=0`);
check('T5', 'R2 outage: PUT fails, complete answers 5xx (phone retries), no media row', u6.put >= 500 && u6.completeStatus >= 500 && await count(`okb_bridge_media?sha256=eq.${sha(photo6)}`) === 0, { put: u6.put, complete: u6.completeStatus });
const u6retry = await uploadMedia({ bytes: photo6, fp: m6.fp, mediaType: 'IMAGE', mime: 'image/jpeg', at: now });
check('T5', 'after R2 recovers the retry stores it once', u6retry.completeStatus === 201 && await count(`okb_bridge_media?sha256=eq.${sha(photo6)}`) === 1, { complete: u6retry.completeStatus });
const page5 = await (await web('/api/media-collector')).json();
check('T5', 'Media page shows no item for the never-stored file', !page5.data.items.some((i) => i.messageText === 'E2E T5 never uploaded'), { total: page5.data.total });

fs.writeFileSync(path.join(DIR, 'phone-sim-results.json'), JSON.stringify({ at: now.toISOString(), results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
