#!/usr/bin/env node
/**
 * Migrate a legacy grokbot_wall_state JSON blob into normalized tables.
 *
 * Leaves the blob row untouched (backup). Idempotent: safe to re-run.
 *
 * Usage:
 *   # From Supabase blob (default row id "default"):
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/migrate-to-normalized.mjs
 *
 *   # From local Postgres (after applying supabase/schema.sql):
 *   DATABASE_URL=postgres://wall:wall@127.0.0.1/grokbot_wall \
 *     node scripts/migrate-to-normalized.mjs --from-file path/to/state.json
 *
 *   # Options:
 *   --row default          Blob row id in grokbot_wall_state (default: default / SUPABASE_ROW_ID)
 *   --from-file state.json Read blob from a file instead of grokbot_wall_state
 *   --dry-run              Print summary only
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
  }
} catch {}

function die(msg) { console.error(`\n  ✗ ${msg}\n`); process.exit(1); }
const referralUrl = (code) => `https://cursor.com/referral?code=${encodeURIComponent(code)}`;

const args = process.argv.slice(2);
const opts = {
  row: process.env.SUPABASE_ROW_ID || 'default',
  fromFile: null,
  dryRun: false,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--row') opts.row = args[++i];
  else if (a === '--from-file') opts.fromFile = path.resolve(args[++i]);
  else if (a === '--dry-run') opts.dryRun = true;
  else die(`unknown flag ${a}`);
}

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const usePg = Boolean(DATABASE_URL);
const useRest = Boolean(SB_URL && SB_KEY);
if (!usePg && !useRest) die('set DATABASE_URL or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

const sbHeaders = useRest ? {
  apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json',
} : null;

let pool;
async function q(text, params) {
  if (!pool) pool = new pg.Pool({ connectionString: DATABASE_URL });
  return pool.query(text, params);
}
async function rest(pathname, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathname}`, {
    method,
    headers: { ...sbHeaders, ...headers },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) throw new Error(`${method} ${pathname} → ${r.status} ${String(typeof json === 'object' ? JSON.stringify(json) : json).slice(0, 400)}`);
  return json;
}

async function loadBlob() {
  if (opts.fromFile) {
    if (!fs.existsSync(opts.fromFile)) die(`file not found: ${opts.fromFile}`);
    return JSON.parse(fs.readFileSync(opts.fromFile, 'utf8'));
  }
  if (usePg) {
    const r = await q('select data from public.grokbot_wall_state where id = $1', [opts.row]);
    if (!r.rows.length) die(`no grokbot_wall_state row id=${opts.row}`);
    return r.rows[0].data;
  }
  const rows = await rest(`grokbot_wall_state?id=eq.${encodeURIComponent(opts.row)}&select=data`);
  if (!rows?.length) die(`no grokbot_wall_state row id=${opts.row}`);
  return rows[0].data;
}

async function upsertSetting(key, value) {
  if (usePg) {
    await q(
      `insert into public.grokbot_wall_settings (key, value, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
    return;
  }
  await rest('grokbot_wall_settings?on_conflict=key', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [{ key, value, updated_at: new Date().toISOString() }],
  });
}

async function upsertEvent(ev) {
  if (usePg) {
    if (ev.is_current) await q('update public.grokbot_wall_events set is_current = false where is_current');
    await q(
      `insert into public.grokbot_wall_events (id, name, start_at, end_at, is_current, updated_at)
       values ($1,$2,$3,$4,$5, now())
       on conflict (id) do update set
         name = coalesce(nullif(excluded.name,''), grokbot_wall_events.name),
         start_at = coalesce(excluded.start_at, grokbot_wall_events.start_at),
         end_at = coalesce(excluded.end_at, grokbot_wall_events.end_at),
         is_current = excluded.is_current,
         updated_at = now()`,
      [ev.id, ev.name || '', ev.start_at || null, ev.end_at || null, !!ev.is_current],
    );
    return;
  }
  if (ev.is_current) {
    const cur = await rest('grokbot_wall_events?is_current=eq.true&select=id');
    for (const o of cur || []) {
      if (o.id === ev.id) continue;
      await rest(`grokbot_wall_events?id=eq.${encodeURIComponent(o.id)}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { is_current: false },
      });
    }
  }
  await rest('grokbot_wall_events?on_conflict=id', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [{
      id: ev.id, name: ev.name || '', start_at: ev.start_at || null, end_at: ev.end_at || null,
      is_current: !!ev.is_current, updated_at: new Date().toISOString(),
    }],
  });
}

async function upsertCode(row) {
  if (usePg) {
    await q(
      `insert into public.grokbot_wall_codes (code, pool, url, position)
       values ($1,$2,$3,$4)
       on conflict (code) do update set
         pool = excluded.pool, url = excluded.url, position = excluded.position
       where grokbot_wall_codes.allocation_id is null`,
      [row.code, row.pool, row.url, row.position],
    );
    return;
  }
  await rest('grokbot_wall_codes?on_conflict=code', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [row],
  });
}

async function findAlloc(eventId, key) {
  if (usePg) {
    const r = await q(
      'select id from public.grokbot_wall_allocations where event_id=$1 and guest_key=$2',
      [eventId, key],
    );
    return r.rows[0] || null;
  }
  const rows = await rest(
    `grokbot_wall_allocations?event_id=eq.${encodeURIComponent(eventId)}&guest_key=eq.${encodeURIComponent(key)}&select=id`,
  );
  return rows?.[0] || null;
}

async function insertAlloc(a) {
  const existing = await findAlloc(a.eventId, a.key);
  if (existing) return { id: existing.id, created: false };

  if (usePg) {
    const r = await q(
      `insert into public.grokbot_wall_allocations (
         event_id, guest_key, email, name, source, checked_in_at, allocated_at,
         mail_status, mail_to, mail_at, mail_tries, mail_error, mail_reason, mail_provider_id
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (event_id, guest_key) do update set guest_key = excluded.guest_key
       returning id`,
      [
        a.eventId, a.key, a.email || '', a.name || '', a.source || 'luma',
        a.checkedInAt || null, a.at || new Date().toISOString(),
        a.mail?.status || null, a.mail?.to || null, a.mail?.at || null,
        a.mail?.tries || 0, a.mail?.error || null, a.mail?.reason || null, a.mail?.id || null,
      ],
    );
    return { id: r.rows[0].id, created: true };
  }
  const rows = await rest('grokbot_wall_allocations?on_conflict=event_id,guest_key', {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
    body: [{
      event_id: a.eventId, guest_key: a.key, email: a.email || '', name: a.name || '',
      source: a.source || 'luma', checked_in_at: a.checkedInAt || null,
      allocated_at: a.at || new Date().toISOString(),
      mail_status: a.mail?.status || null, mail_to: a.mail?.to || null, mail_at: a.mail?.at || null,
      mail_tries: a.mail?.tries || 0, mail_error: a.mail?.error || null,
      mail_reason: a.mail?.reason || null, mail_provider_id: a.mail?.id || null,
    }],
  });
  if (rows?.length) return { id: rows[0].id, created: true };
  const again = await findAlloc(a.eventId, a.key);
  return { id: again.id, created: false };
}

async function assignCode(code, allocationId, usedAt) {
  if (usePg) {
    await q(
      `update public.grokbot_wall_codes
       set allocation_id = $2, used_at = coalesce($3::timestamptz, now())
       where code = $1 and (allocation_id is null or allocation_id = $2)`,
      [code, allocationId, usedAt || null],
    );
    return;
  }
  await rest(`grokbot_wall_codes?code=eq.${encodeURIComponent(code)}`, {
    method: 'PATCH', headers: { prefer: 'return=minimal' },
    body: { allocation_id: allocationId, used_at: usedAt || new Date().toISOString() },
  });
}

const blob = await loadBlob();
const config = blob.config || {};
const codes = blob.codes || { A: [], B: [] };
const allocations = Array.isArray(blob.allocations) ? blob.allocations : [];

const eventIds = new Set();
if (config.eventId) eventIds.add(config.eventId);
for (const a of allocations) if (a.eventId) eventIds.add(a.eventId);

console.log(`\n  migrate-to-normalized`);
console.log(`    source     ${opts.fromFile || `grokbot_wall_state id=${opts.row}`}`);
console.log(`    backend    ${usePg ? 'postgres' : 'supabase-rest'}`);
console.log(`    events     ${eventIds.size}`);
console.log(`    codes      A=${(codes.A || []).length} B=${(codes.B || []).length}`);
console.log(`    allocs     ${allocations.length}`);
console.log(`    mailed     ${allocations.filter(a => a.mail && (a.mail.status === 'sent' || a.mail.status === 'dry')).length}`);
if (opts.dryRun) { console.log('    (dry-run — no writes)\n'); process.exit(0); }

// Settings
for (const k of ['poolMode', 'pollMs', 'idlePollMs', 'liveBeforeMs', 'liveAfterMs', 'forceFastPoll',
  'eventId', 'eventName', 'eventStart', 'eventEnd']) {
  if (k in config) await upsertSetting(k, config[k]);
}
if (codes.labels) await upsertSetting('labels', codes.labels);
await upsertSetting('schema_version', 3);
await upsertSetting('migrated_from_blob_at', new Date().toISOString());
await upsertSetting('migrated_from_blob_row', opts.fromFile || opts.row);

// Events
for (const id of eventIds) {
  await upsertEvent({
    id,
    name: id === config.eventId ? (config.eventName || '') : '',
    start_at: id === config.eventId ? config.eventStart : null,
    end_at: id === config.eventId ? config.eventEnd : null,
    is_current: id === config.eventId,
  });
}

// Codes inventory (unassigned first)
let posA = 1, posB = 1;
for (const pool of ['A', 'B']) {
  for (const c of codes[pool] || []) {
    if (!c?.code) continue;
    const position = c.n || (pool === 'B' ? posB : posA);
    if (pool === 'B') posB = Math.max(posB, position + 1); else posA = Math.max(posA, position + 1);
    await upsertCode({
      code: c.code, pool, url: c.url || referralUrl(c.code), position,
    });
  }
}

// Allocations + code assignments (preserves mail status — no re-email)
let created = 0, skipped = 0, linked = 0;
for (const a of allocations) {
  const eventId = a.eventId || config.eventId;
  if (!eventId) { skipped++; continue; }
  const key = String(a.key || a.email || '').toLowerCase();
  if (!key) { skipped++; continue; }
  await upsertEvent({ id: eventId, name: '', is_current: eventId === config.eventId });
  const { id, created: wasNew } = await insertAlloc({ ...a, eventId, key });
  if (wasNew) created++; else skipped++;
  for (const c of a.codes || []) {
    if (!c?.code) continue;
    // Ensure code exists even if missing from inventory
    await upsertCode({
      code: c.code, pool: c.pool === 'B' ? 'B' : 'A',
      url: c.url || referralUrl(c.code),
      position: c.n || (c.pool === 'B' ? posB++ : posA++),
    });
    await assignCode(c.code, id, a.at || a.mail?.at || null);
    linked++;
  }
}

console.log(`    wrote     settings + ${eventIds.size} events`);
console.log(`    allocs    ${created} inserted, ${skipped} already present`);
console.log(`    linked    ${linked} code assignments`);
console.log(`    blob      left untouched (backup)\n`);
console.log(`  ✓ migration complete — restart the wall; it will load from normalized tables.\n`);

if (pool) await pool.end();
