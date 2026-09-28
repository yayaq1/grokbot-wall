#!/usr/bin/env node
/**
 * One-off import of a legacy (bchewy / pre-multi-event) state.json + codes.json
 * into the v2 per-event store shape.
 *
 * Usage:
 *   node scripts/import-legacy.mjs path/to/state.json path/to/codes.json --event evt-XXXX
 *
 * Options:
 *   --event evt-…     Luma event id to attach every legacy allocation to (required)
 *   --event-name "…"  Optional display name stored on config
 *   --out path.json   Write merged state here (default: data/state.json)
 *   --merge           Merge into an existing --out / Supabase row instead of replacing allocations
 *   --supabase        Also upsert into Supabase (needs SUPABASE_* in env / .env)
 *   --dry-run         Print summary only; do not write
 *
 * Legacy state shape: { allocations: [{ key, name, email, codes, mail, … }], config? }
 * Codes shape: { A: [{code,url}], B: [{code,url}], labels? }
 *
 * After import, used codes stay marked used (via allocations), and those check-ins
 * appear under the given event. Restart the wall (or let it reload from Supabase).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
  }
} catch {}

function die(msg) { console.error(`\n  ✗ ${msg}\n`); process.exit(1); }
function referralUrl(code) { return `https://cursor.com/referral?code=${encodeURIComponent(code)}`; }

const args = process.argv.slice(2);
const positional = [];
const opts = { event: null, eventName: '', out: path.join(ROOT, 'data/state.json'), merge: false, supabase: false, dryRun: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--event') opts.event = args[++i];
  else if (a === '--event-name') opts.eventName = args[++i];
  else if (a === '--out') opts.out = path.resolve(args[++i]);
  else if (a === '--merge') opts.merge = true;
  else if (a === '--supabase') opts.supabase = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a.startsWith('-')) die(`unknown flag ${a}`);
  else positional.push(a);
}

if (positional.length < 2) {
  die('usage: node scripts/import-legacy.mjs state.json codes.json --event evt-… [--event-name "…"] [--out data/state.json] [--merge] [--supabase] [--dry-run]');
}
if (!opts.event) die('--event evt-… is required');

const statePath = path.resolve(positional[0]);
const codesPath = path.resolve(positional[1]);
if (!fs.existsSync(statePath)) die(`state file not found: ${statePath}`);
if (!fs.existsSync(codesPath)) die(`codes file not found: ${codesPath}`);

let legacyState, legacyCodes;
try { legacyState = JSON.parse(fs.readFileSync(statePath, 'utf8')); }
catch (e) { die(`bad state JSON: ${e.message}`); }
try { legacyCodes = JSON.parse(fs.readFileSync(codesPath, 'utf8')); }
catch (e) { die(`bad codes JSON: ${e.message}`); }
if (!Array.isArray(legacyState.allocations)) die('state.json needs an "allocations" array');
if (!Array.isArray(legacyCodes.A) || !Array.isArray(legacyCodes.B)) die('codes.json needs "A" and "B" arrays');

function cloneCodes(c) {
  return {
    A: (c.A || []).map(x => ({ code: x.code, url: x.url || referralUrl(x.code) })),
    B: (c.B || []).map(x => ({ code: x.code, url: x.url || referralUrl(x.code) })),
    labels: { ...(c.labels || { A: 'Pool A', B: 'Pool B' }) },
  };
}
function allCodes(codes) {
  const s = new Set();
  for (const p of ['A', 'B']) for (const c of codes[p] || []) if (c?.code) s.add(c.code);
  return s;
}
function mergeCodes(into, from) {
  const have = allCodes(into);
  let added = 0;
  for (const p of ['A', 'B']) {
    for (const c of from[p] || []) {
      if (!c?.code || have.has(c.code)) continue;
      into[p].push({ code: c.code, url: c.url || referralUrl(c.code) });
      have.add(c.code); added++;
    }
  }
  if (from.labels) into.labels = { ...into.labels, ...from.labels };
  return added;
}
function indexOf(codes, pool, code) {
  const i = (codes[pool] || []).findIndex(x => x.code === code);
  return i >= 0 ? i + 1 : 0;
}

let base = { version: 2, allocations: [], codes: cloneCodes(legacyCodes), config: { eventId: opts.event, eventName: opts.eventName || '', poolMode: 'A-then-B', pollMs: 5000 } };
if (opts.merge && fs.existsSync(opts.out)) {
  try {
    const existing = JSON.parse(fs.readFileSync(opts.out, 'utf8'));
    base.allocations = Array.isArray(existing.allocations) ? existing.allocations.map(a => ({ ...a })) : [];
    if (existing.codes) base.codes = cloneCodes(existing.codes);
    base.config = { ...base.config, ...(existing.config || {}), eventId: opts.event, eventName: opts.eventName || existing.config?.eventName || '' };
    mergeCodes(base.codes, legacyCodes);
  } catch (e) { die(`could not read existing --out for --merge: ${e.message}`); }
} else {
  if (legacyState.config) base.config = { ...base.config, ...legacyState.config, eventId: opts.event, eventName: opts.eventName || legacyState.config.eventName || '' };
}

const existingKeys = new Set(base.allocations.filter(a => a.eventId === opts.event).map(a => a.key));
let imported = 0, skipped = 0, mailed = 0;
for (const raw of legacyState.allocations) {
  const key = String(raw.key || raw.email || '').trim().toLowerCase();
  if (!key) { skipped++; continue; }
  if (existingKeys.has(key)) { skipped++; continue; }
  const codes = (raw.codes || []).map(c => ({
    pool: c.pool || 'A',
    code: c.code,
    url: c.url || referralUrl(c.code),
    n: c.n || indexOf(base.codes, c.pool || 'A', c.code) || undefined,
  }));
  // Ensure every allocated code exists in the pool inventory (so remaining counts stay honest).
  for (const c of codes) {
    const pool = c.pool === 'B' ? 'B' : 'A';
    if (!(base.codes[pool] || []).some(x => x.code === c.code)) {
      base.codes[pool].push({ code: c.code, url: c.url });
    }
    if (!c.n) c.n = indexOf(base.codes, pool, c.code);
  }
  const a = {
    key,
    eventId: opts.event,
    name: raw.name || '',
    email: raw.email || '',
    checkedInAt: raw.checkedInAt || null,
    source: raw.source || 'luma',
    at: raw.at || new Date().toISOString(),
    codes,
  };
  if (raw.mail) a.mail = { ...raw.mail };   // preserve sent/failed so restart does not re-email
  if (a.mail && (a.mail.status === 'sent' || a.mail.status === 'dry')) mailed++;
  base.allocations.push(a);
  existingKeys.add(key);
  imported++;
}

const used = new Set();
for (const a of base.allocations) for (const c of a.codes || []) if (c.code) used.add(c.code);
const remaining = [...allCodes(base.codes)].filter(c => !used.has(c)).length;

console.log(`\n  import-legacy`);
console.log(`    event       ${opts.event}${opts.eventName ? ` "${opts.eventName}"` : ''}`);
console.log(`    imported    ${imported} allocations (${skipped} skipped)`);
console.log(`    already mailed (preserved): ${mailed}`);
console.log(`    codes       A=${base.codes.A.length} B=${base.codes.B.length} · used ${used.size} · remaining ${remaining}`);
console.log(`    out         ${opts.out}${opts.supabase ? ' + supabase' : ''}${opts.dryRun ? ' (dry-run)' : ''}\n`);

if (opts.dryRun) process.exit(0);

fs.mkdirSync(path.dirname(opts.out), { recursive: true });
fs.writeFileSync(opts.out, JSON.stringify(base, null, 2));
console.log(`  ✓ wrote ${opts.out}`);

if (opts.supabase) {
  const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const SB_ROW = process.env.SUPABASE_ROW_ID || 'default';
  if (!SB_URL || !SB_KEY) die('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for --supabase');
  const r = await fetch(`${SB_URL}/rest/v1/wall_state?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`,
      'content-type': 'application/json', prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ id: SB_ROW, data: base, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) die(`supabase upsert failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  console.log(`  ✓ upserted supabase row "${SB_ROW}"`);
}
