#!/usr/bin/env node
// Grok Bot check-in wall: static server + Luma API proxy + shared allocation state.
// Usage:  LUMA_API_KEY=... node serve.mjs   (or put the key in .env)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---- .env (only fills vars that are not already set) ----
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');   // an explicitly empty env var wins over .env
  }
} catch {}

const KEY = process.env.LUMA_API_KEY || '';
const PORT = Number(process.env.PORT || 8787);
const LUMA = 'https://public-api.luma.com';
// data/codes.json is gitignored and never in the image, so a host with no writable disk carries
// the real codes in CODES_JSON instead. Same JSON either way — used as the initial seed only;
// once state is persisted, staff-added codes live in the store.
const CODES_FILE = fs.existsSync(path.join(ROOT, 'data/codes.json')) ? 'data/codes.json' : 'data/codes.example.json';
const CODES_SRC = process.env.CODES_JSON ? 'CODES_JSON' : CODES_FILE;
if (!process.env.CODES_JSON && CODES_FILE.includes('example')) console.warn('  ! data/codes.json not found — using the placeholder codes from data/codes.example.json');
let seedCodes;
try { seedCodes = JSON.parse(process.env.CODES_JSON || fs.readFileSync(path.join(ROOT, CODES_FILE), 'utf8')); }
catch (e) { console.error(`\n  ✗ could not parse codes from ${CODES_SRC}: ${e.message}\n`); process.exit(1); }
if (!Array.isArray(seedCodes.A) || !Array.isArray(seedCodes.B)) { console.error(`\n  ✗ codes from ${CODES_SRC} need "A" and "B" arrays\n`); process.exit(1); }
const STATE_FILE = path.join(ROOT, 'data/state.json');

// ---- state store: Supabase when configured, the JSON file otherwise ----
// The file is still written either way, as a local cache. On hosts with no disk the write is a
// no-op or fails quietly; Supabase is the source of truth.
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SB_ROW = process.env.SUPABASE_ROW_ID || 'default';
// Namespaced table — see supabase/schema.sql (shared project with other apps).
const SB_TABLE = 'grokbot_wall_state';
const sbOn = Boolean(SB_URL && SB_KEY);
const sbHeaders = { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' };
async function sbLoad() {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?id=eq.${encodeURIComponent(SB_ROW)}&select=data`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  const rows = await r.json(); return rows[0] ? rows[0].data : null;
}
/** Cheapest authenticated read — keeps a free-tier Supabase project from pausing. No row payload used. */
async function sbTouch() {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?id=eq.${encodeURIComponent(SB_ROW)}&select=id`, {
    headers: { ...sbHeaders, accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  await r.arrayBuffer();
}
async function sbSave(snapshot) {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?on_conflict=id`, {
    method: 'POST', headers: { ...sbHeaders, prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ id: SB_ROW, data: snapshot, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
}

const DEFAULT_CONFIG = {
  eventId: process.env.LUMA_EVENT_ID || null,
  eventName: '',
  eventStart: null,
  eventEnd: null,
  poolMode: 'A-then-B',
  // Fast poll during the live window; idle poll otherwise (webhook is primary off-window).
  pollMs: Math.max(2000, Number(process.env.POLL_MS) || 5000),
  idlePollMs: Math.max(60_000, Number(process.env.IDLE_POLL_MS) || 900_000),   // default 15 min
  liveBeforeMs: Math.max(0, (Number(process.env.LIVE_BEFORE_MIN) || 60) * 60_000),
  liveAfterMs: Math.max(0, (Number(process.env.LIVE_AFTER_MIN) || 120) * 60_000),
  forceFastPoll: false,   // staff override: keep fast polling regardless of window
};
let state = { version: 2, allocations: [], codes: null, config: { ...DEFAULT_CONFIG } };

function cloneCodes(c) {
  return {
    A: (c.A || []).map(x => ({ code: x.code, url: x.url || referralUrl(x.code) })),
    B: (c.B || []).map(x => ({ code: x.code, url: x.url || referralUrl(x.code) })),
    labels: { ...(c.labels || { A: 'Pool A', B: 'Pool B' }) },
  };
}
function referralUrl(code) { return `https://cursor.com/referral?code=${encodeURIComponent(code)}`; }
function allCodeSet(codes = state.codes) {
  const s = new Set();
  for (const p of ['A', 'B']) for (const c of codes?.[p] || []) if (c?.code) s.add(c.code);
  return s;
}
function usedCodeSet(allocations = state.allocations) {
  const s = new Set();
  for (const a of allocations) for (const c of a.codes || []) if (c?.code) s.add(c.code);
  return s;
}
function mergeSeedInto(codes, seed) {
  const have = allCodeSet(codes);
  let added = 0;
  for (const pool of ['A', 'B']) {
    for (const c of seed[pool] || []) {
      if (!c?.code || have.has(c.code)) continue;
      codes[pool].push({ code: c.code, url: c.url || referralUrl(c.code) });
      have.add(c.code);
      added++;
    }
  }
  if (seed.labels) codes.labels = { ...codes.labels, ...seed.labels };
  return added;
}
/** Upgrade legacy (v1) snapshots: tag allocations with an event, seed the code pool. */
function normalizeState(raw, seed) {
  const s = {
    version: 2,
    allocations: Array.isArray(raw?.allocations) ? raw.allocations.map(a => ({ ...a })) : [],
    codes: raw?.codes && Array.isArray(raw.codes.A) && Array.isArray(raw.codes.B) ? cloneCodes(raw.codes) : cloneCodes(seed),
    config: { ...DEFAULT_CONFIG, ...(raw?.config || {}) },
  };
  if (!s.config.eventId && process.env.LUMA_EVENT_ID) s.config.eventId = process.env.LUMA_EVENT_ID;
  // Legacy rows keyed only by email: attach the configured event so they stay visible under it.
  const fallbackEvent = s.config.eventId || null;
  for (const a of s.allocations) {
    if (!a.eventId && fallbackEvent) a.eventId = fallbackEvent;
    for (const c of a.codes || []) if (!c.n && c.pool && c.code) c.n = codeIndexInPool(s.codes, c.pool, c.code);
  }
  mergeSeedInto(s.codes, seed);
  return s;
}
function codeIndexInPool(codes, pool, code) {
  const i = (codes[pool] || []).findIndex(x => x.code === code);
  return i >= 0 ? i + 1 : 0;
}

const merge = s => { state = normalizeState({ ...state, ...s, config: { ...state.config, ...(s.config || {}) }, codes: s.codes || state.codes, allocations: s.allocations ?? state.allocations }, seedCodes); };
if (sbOn) {
  // Fail fast rather than start from a stale file: running on the wrong allocation list hands
  // guests codes that were already given away. Free hosts restart us, so a blip self-heals.
  let remote;
  try { remote = await sbLoad(); }
  catch (e) { console.error(`\n  ✗ supabase unreachable: ${e.message}\n    refusing to start on possibly stale state — fix SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY\n`); process.exit(1); }
  if (remote) { merge(remote); console.log(`  ◇ state from supabase (${state.allocations.length} allocations, ${allCodeSet().size} codes)`); }
  else { state = normalizeState(state, seedCodes); console.log('  ◇ supabase reachable, no state row yet — starting fresh'); }
} else {
  try { merge(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch { state = normalizeState(state, seedCodes); }
}

let sbChain = Promise.resolve();
const save = () => {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { if (sbOn) { /* ephemeral disk — supabase is SoT */ } else console.error(`  ✗ state file write failed: ${e.message}`); }
  if (!sbOn) return;
  const snapshot = structuredClone(state);   // state keeps mutating while the request is in flight
  sbChain = sbChain.then(() => sbSave(snapshot)).catch(e => console.error(`  ✗ supabase save failed: ${e.message}`));
};
// Persist normalized shape (codes in store, event tags) so a restart sees the same pool.
save();

function currentEventId() { return state.config.eventId || (luma.event && luma.event.id) || null; }
function allocsFor(eventId) {
  if (!eventId) return [];
  return state.allocations.filter(a => a.eventId === eventId);
}
function findAlloc(eventId, key) {
  return state.allocations.find(a => a.eventId === eventId && a.key === key);
}
function mailKey(a) { return `${a.eventId}|${a.key}`; }
function parseMailKey(k) { const i = String(k).indexOf('|'); return i < 0 ? { eventId: null, key: k } : { eventId: k.slice(0, i), key: k.slice(i + 1) }; }
function poolStats() {
  const used = usedCodeSet();
  const rem = p => (state.codes[p] || []).filter(c => !used.has(c.code)).length;
  return {
    A: state.codes.A.length, B: state.codes.B.length,
    used: { A: (state.codes.A || []).filter(c => used.has(c.code)).length, B: (state.codes.B || []).filter(c => used.has(c.code)).length },
    remaining: { A: rem('A'), B: rem('B'), total: rem('A') + rem('B') },
  };
}

// ---- email (Resend / Mailgun / SMTP) ----
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MG_KEY = process.env.MAILGUN_API_KEY || '';
const MG_DOMAIN = process.env.MAILGUN_DOMAIN || '';
const MG_BASE = (process.env.MAILGUN_BASE || 'https://api.mailgun.net').replace(/\/$/, '');   // api.eu.mailgun.net for EU accounts
const MG_ON = Boolean(MG_KEY && MG_DOMAIN);
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s+/g, '');   // Google prints app passwords in 4-char groups
const SMTP_ON = Boolean(SMTP_USER && SMTP_PASS);
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER || 'Grok Bot <onboarding@resend.dev>';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';
const EVENT_NAME_FALLBACK = process.env.EVENT_NAME || '';
const EMAIL_EVENT_OVERRIDE = process.env.EMAIL_EVENT_NAME || '';
const EMAIL_DRY_RUN = /^(1|true|yes)$/i.test(process.env.EMAIL_DRY_RUN || '');
const EMAIL_TEST_TO = process.env.EMAIL_TEST_TO || '';           // if set, every guest email is redirected here
const EMAIL_OFF = /^(1|true|yes)$/i.test(process.env.EMAIL_OFF || '');

function resolveEmailProvider() {
  const want = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (want === 'resend') return RESEND_KEY ? 'resend' : null;
  if (want === 'mailgun') return MG_ON ? 'mailgun' : null;
  if (want === 'smtp') return SMTP_ON ? 'smtp' : null;
  if (want) return null;   // explicit but unavailable
  // First-configured wins: Resend (HTTP, good on free PaaS) → Mailgun → SMTP.
  if (RESEND_KEY) return 'resend';
  if (MG_ON) return 'mailgun';
  if (SMTP_ON) return 'smtp';
  return null;
}
const emailProvider = () => (EMAIL_DRY_RUN ? (resolveEmailProvider() || 'dry') : resolveEmailProvider());
const emailEnabled = () => !EMAIL_OFF && (EMAIL_DRY_RUN || Boolean(resolveEmailProvider()));
const emailInfo = () => {
  const p = resolveEmailProvider();
  const host = EMAIL_DRY_RUN ? 'dry-run' : p === 'resend' ? 'resend' : p === 'mailgun' ? `mailgun · ${MG_DOMAIN}` : p === 'smtp' ? SMTP_HOST : '';
  return { enabled: emailEnabled(), dryRun: EMAIL_DRY_RUN, provider: p || (EMAIL_DRY_RUN ? 'dry' : null), from: EMAIL_FROM, testTo: EMAIL_TEST_TO, host, user: p === 'mailgun' ? MG_DOMAIN : p === 'smtp' ? SMTP_USER : (p === 'resend' ? 'resend' : ''), hasKey: Boolean(p) };
};
const isEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ''));
const escHtml = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function currentEventName() {
  return EMAIL_EVENT_OVERRIDE || (luma.event && luma.event.name) || state.config.eventName || EVENT_NAME_FALLBACK || 'Grok Bot Meetup';
}
function emailSubject() {
  return process.env.EMAIL_SUBJECT || `Your Cursor credits from ${currentEventName()}`;
}

// one pooled connection, reused across the queue. Timeouts matter: a stalled socket is what wedged the queue on event day.
let mailer = null;
const transport = () => (mailer ||= nodemailer.createTransport({
  host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  pool: true, maxConnections: 1,   // pumpMail sends one at a time anyway
  family: 4,   // PaaS containers often have no IPv6 route; Gmail resolves to both and Node may pick v6
  connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000,
}));

async function sendMailgun({ from, to, replyTo, subject, html, text }) {
  const form = new URLSearchParams({ from, to, subject, html, text });
  if (replyTo) form.set('h:Reply-To', replyTo);
  let r;
  try {
    r = await fetch(`${MG_BASE}/v3/${MG_DOMAIN}/messages`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`api:${MG_KEY}`).toString('base64') },
      body: form, signal: AbortSignal.timeout(20000),
    });
  } catch (e) { const err = new Error(`mailgun ${e.message}`); err.permanent = false; throw err; }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`${r.status} ${body.message || ''}`.trim());
    err.permanent = r.status >= 400 && r.status < 500 && r.status !== 429;
    throw err;
  }
  return body.id || null;
}

async function sendResend({ from, to, replyTo, subject, html, text }) {
  let r;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: replyTo || undefined, subject, html, text }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { const err = new Error(`resend ${e.message}`); err.permanent = false; throw err; }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`${r.status} ${body.message || body.name || ''}`.trim());
    // Resend: 429 retry; most 4xx are permanent (bad key / unverified domain / bad recipient)
    err.permanent = r.status >= 400 && r.status < 500 && r.status !== 429;
    throw err;
  }
  return body.id || null;
}

function renderEmail(a) {
  const first = String(a.name || '').trim().split(/\s+/)[0] || 'there';
  const many = a.codes.length > 1;
  const eventLabel = currentEventName();
  const subject = emailSubject();
  const hero = PUBLIC_URL ? `${PUBLIC_URL}/assets/hero-blue.jpg` : '';
  const BLUE = '#0B72E1', INK = '#111318', MUTED = '#5b606b', LINE = '#e6e8ee', PANEL = '#f3f4f7';
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif";
  const labels = state.codes?.labels || {};
  const codeBlocks = a.codes.map(c => `
    <tr><td style="padding:0 0 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:12px;background:${PANEL}">
        <tr><td style="padding:18px 20px 6px;font:600 11px/1 ${font};letter-spacing:.14em;color:${MUTED};text-transform:uppercase">Cursor credits${many ? ` &middot; ${escHtml(labels[c.pool] || c.pool)}` : ''} &middot; your code</td></tr>
        <tr><td style="padding:0 20px 14px;font:600 24px/1.3 Menlo,Consolas,'Courier New',monospace;color:${INK};letter-spacing:.03em;word-break:break-all">${escHtml(c.code)}</td></tr>
        <tr><td style="padding:0 20px 18px">
          <a href="${escHtml(c.url)}" style="display:inline-block;background:${BLUE};color:#ffffff;font:600 15px/1 ${font};text-decoration:none;padding:14px 24px;border-radius:10px">Redeem credits on cursor.com</a>
          <div style="padding-top:10px;font:12px/1.6 ${font};color:${MUTED}">or open <a href="${escHtml(c.url)}" style="color:${BLUE}">${escHtml(c.url)}</a></div>
        </td></tr>
      </table>
    </td></tr>`).join('');
  const STEPS = [
    ['Account + app', 'Create a fresh Cursor account, or sign in to an existing <b>personal</b> one. Download Grok Bot from <a href="https://x.ai/bot" style="color:' + BLUE + '">x.ai/bot</a> (Mac or Windows) and sign in.'],
    ['Start the trial', 'Activate the Grok Bot trial and enter card details when asked. There is usually no OTP and no charge at this step. You land in Grok Bot onboarding; the free trial runs until you hit 100% usage (resets every 7 days on free plans).'],
    ['Redeem the credits', 'Stay logged into that same Cursor account and open the credits link above. Click <b>Get Started</b>. The credits land on cursor.com/dashboard under Billing.'],
    ['When the trial hits its limit', 'The free trial is only a few minutes of real use. When it stops you get a popup: <b>Upgrade with Grok</b> or <b>Upgrade to Pro</b>. Choose <b>Upgrade to Pro</b>; that is the path that applies your Cursor credit.'],
    ['Checkout', 'You land on Cursor&rsquo;s Stripe page with the credit already applied, so the total should be <b>$0</b>. Enter card details and complete checkout. Tax is drawn from the credits too.'],
  ];
  const NOTES = [
    'The credits link works until it is redeemed. Make sure you are on the correct <b>non-Team</b> account before you click Get Started.',
    'A card is required twice on a fresh account: once for trial verification, once for the $0 Pro checkout. No charge at the trial in our test run.',
    'Don&rsquo;t pick <b>Upgrade with Grok</b>. That goes to x.ai / Google sign-in and does not apply this Cursor credit.',
    'Credits won&rsquo;t work on a Team plan.',
    'If the credits don&rsquo;t show after redeeming: hard refresh, or log out and back in, then check Dashboard &rsaquo; Credits.',
  ];
  const stepRows = STEPS.map(([title, body], i) => `
    <tr>
      <td valign="top" style="padding:0 14px 18px 0;width:32px"><div style="width:30px;height:30px;border-radius:15px;background:${BLUE};color:#fff;font:700 14px/30px ${font};text-align:center">${i + 1}</div></td>
      <td valign="top" style="padding:0 0 18px;font:14px/1.6 ${font};color:${INK}"><div style="font-weight:700;padding:4px 0 2px">${title}</div><div style="color:#3a3f4a">${body}</div></td>
    </tr>`).join('');
  const noteRows = NOTES.map(n => `<tr><td valign="top" style="padding:0 10px 8px 0;font:14px/1.6 ${font};color:${BLUE}">&bull;</td><td style="padding:0 0 8px;font:14px/1.6 ${font};color:#3a3f4a">${n}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${PANEL};font-family:${font}">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">Your Cursor credits code from ${escHtml(eventLabel)}, plus how to redeem it.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PANEL};padding:28px 12px"><tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid ${LINE}">
      ${hero ? `<tr><td style="line-height:0"><img src="${hero}" width="600" alt="Grok Bot" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>` : ""}
      <tr><td style="padding:30px 32px 0">
        <div style="font:600 11px/1 ${font};letter-spacing:.14em;color:${MUTED};text-transform:uppercase">${escHtml(eventLabel)}</div>
        <div style="padding-top:12px;font:700 26px/1.25 ${font};color:${INK}">Hi ${escHtml(first)}, you&rsquo;re checked in.</div>
        <div style="padding:12px 0 22px;font:15px/1.65 ${font};color:#3a3f4a">Thanks for coming. Grok Bot has set aside your Cursor credits &mdash; ${many ? 'here are your codes' : 'here is your code'}, followed by the exact steps to turn ${many ? 'them' : 'it'} into a Pro plan for the Build.</div>
      </td></tr>
      <tr><td style="padding:0 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${codeBlocks}</table></td></tr>
      <tr><td style="padding:8px 32px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:4px solid ${BLUE};background:#eef5fd;border-radius:0 10px 10px 0"><tr><td style="padding:12px 16px;font:14px/1.6 ${font};color:${INK}"><b>Before you start:</b> use the credits link on a <b>single-user</b> Cursor account (not a Team plan), in the same browser you&rsquo;ll use for the steps below.</td></tr></table>
      </td></tr>
      <tr><td style="padding:28px 32px 0">
        <div style="font:700 18px/1.3 ${font};color:${INK};padding-bottom:16px">How to redeem</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stepRows}</table>
        <div style="font:14px/1.6 ${font};color:#3a3f4a;padding:2px 0 0">Grok Bot picks up the plan on its own and usage resets to around 1%. You&rsquo;re all set.</div>
      </td></tr>
      <tr><td style="padding:26px 32px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PANEL};border-radius:12px"><tr><td style="padding:18px 20px 12px">
          <div style="font:700 15px/1.3 ${font};color:${INK};padding-bottom:10px">Notes</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${noteRows}</table>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:26px 32px 30px;font:12px/1.7 ${font};color:${MUTED};border-top:1px solid ${LINE}">Sent by the check-in desk at ${escHtml(eventLabel)}, a community event. Stuck? Just reply to this email.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  const strip = t => t.replace(/<[^>]+>/g, '').replace(/&rsquo;/g, "'").replace(/&rsaquo;/g, '>').replace(/&middot;/g, '·').replace(/&mdash;/g, '—').replace(/&bull;/g, '•').replace(/&amp;/g, '&');
  const text = `Hi ${first}, you're checked in at ${eventLabel}.

Thanks for coming. ${many ? 'Here are your Cursor referral codes' : 'Here is your Cursor referral code'}:

${a.codes.map(c => `  ${c.code}\n  ${c.url}`).join('\n\n')}

BEFORE YOU START
Use the credits link on a single-user Cursor account (not a Team plan), in the same browser you'll use for the steps below.

HOW TO REDEEM
${STEPS.map(([t, b], i) => `${i + 1}. ${t}\n   ${strip(b)}`).join('\n\n')}

Grok Bot picks up the plan on its own and usage resets to around 1%. You're all set.

NOTES
${NOTES.map(n => `- ${strip(n)}`).join('\n')}

Stuck? Just reply to this email.
`;
  return { subject, html, text };
}

async function deliver(a, { to, tag = '' } = {}) {
  const msg = renderEmail(a);
  const dest = to || EMAIL_TEST_TO || a.email;
  const subject = (!to && EMAIL_TEST_TO ? `[TEST → ${a.email}] ` : '') + tag + msg.subject;
  const at = new Date().toISOString();
  if (EMAIL_DRY_RUN) { console.log(`  ✉ dry-run → ${dest}  (${a.name || a.key})`); return { status: 'dry', to: dest, at, subject }; }
  const provider = resolveEmailProvider();
  if (!provider) return { status: 'failed', to: dest, at, error: 'no email provider configured' };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const fields = { from: EMAIL_FROM, to: dest, replyTo: EMAIL_REPLY_TO || undefined, subject, html: msg.html, text: msg.text };
      let id = null;
      if (provider === 'resend') id = await sendResend(fields);
      else if (provider === 'mailgun') id = await sendMailgun(fields);
      else id = (await transport().sendMail(fields)).messageId || null;
      console.log(`  ✉ sent → ${dest}  (${a.name || a.key})  ${id || ''}  [${provider}]`);
      return { status: 'sent', to: dest, at, id, provider };
    } catch (e) {
      const code = e.responseCode || 0;
      const err = `${code || e.code || ''} ${e.message || e}`.trim();
      // permanent: SMTP 5xx, or HTTP 4xx (except 429) from Resend/Mailgun
      const permanent = (provider === 'resend' || provider === 'mailgun') ? e.permanent === true : code >= 500;
      if (permanent) return { status: 'failed', to: dest, at, error: err, provider };
      if (attempt === 3) return { status: 'failed', to: dest, at, error: `${err} (gave up)`, provider };
      await sleep(1500 * (attempt + 1));
    }
  }
}

// ---- access token: everything except webhook / assets / healthz needs it when WALL_TOKEN is set ----
const WALL_TOKEN = process.env.WALL_TOKEN || '';
const authed = (req, url) => !WALL_TOKEN || (req.headers['x-wall-key'] || url.searchParams.get('key')) === WALL_TOKEN;

// ---- Luma polling (server-side): the server owns check-in detection, allocation and email ----
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const luma = { event: null, total: 0, guests: new Map(), lastSync: 0, error: '', fullAt: 0, timer: null, running: false };
async function lumaGet(p, q) {
  const u = new URL(LUMA + p); Object.entries(q || {}).forEach(([k, v]) => v != null && u.searchParams.set(k, v));
  const r = await fetch(u, { headers: { 'x-luma-api-key': KEY, accept: 'application/json' } });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`Luma ${r.status} ${j.message || ''}`.trim()); return j;
}
async function lumaPost(p, body) {
  const r = await fetch(LUMA + p, { method: 'POST', headers: { 'x-luma-api-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`Luma ${r.status} ${j.message || ''}`.trim()); return j;
}
const normGuest = e => {
  const t = e.event_tickets || []; const ci = e.checked_in_at || t.map(x => x.checked_in_at).filter(Boolean).sort()[0] || null;
  const name = e.user_name || [e.user_first_name, e.user_last_name].filter(Boolean).join(' ') || e.user_email || 'Guest';
  return { key: String(e.user_email || e.user_id || e.id).toLowerCase(), id: e.id, name, email: e.user_email || '', checkedInAt: ci, approval: e.approval_status };
};
async function resolveEvent() {
  if (state.config.eventId) { const ev = await lumaGet('/v1/events/get', { event_id: state.config.eventId }); return ev.event || ev; }
  const after = new Date(Date.now() - 18 * 3600e3).toISOString();
  const j = await lumaGet('/v1/calendars/events/list', { after, pagination_limit: 10, sort_column: 'start_at', sort_direction: 'asc' });
  const ev = (j.entries || []).map(e => e.event || e)[0]; if (!ev) throw new Error('no upcoming events on this calendar'); return ev;
}
function rememberEvent(ev) {
  luma.event = { id: ev.id, name: ev.name, start_at: ev.start_at || null, end_at: ev.end_at || null };
  const changed = state.config.eventId !== ev.id
    || state.config.eventName !== ev.name
    || state.config.eventStart !== (ev.start_at || null)
    || state.config.eventEnd !== (ev.end_at || null);
  state.config.eventId = ev.id;
  state.config.eventName = ev.name || state.config.eventName || '';
  state.config.eventStart = ev.start_at || state.config.eventStart || null;
  state.config.eventEnd = ev.end_at || null;
  if (changed) save();
}

/** Live window: [start − liveBefore, end + liveAfter]. Unknown schedule → idle (webhook + slow poll). */
function inLiveWindow(now = Date.now()) {
  if (state.config.forceFastPoll) return true;
  const start = Date.parse(state.config.eventStart || (luma.event && luma.event.start_at) || '') || NaN;
  if (!Number.isFinite(start)) return false;
  let end = Date.parse(state.config.eventEnd || (luma.event && luma.event.end_at) || '') || NaN;
  if (!Number.isFinite(end)) end = start + 3 * 3600e3;   // Luma sometimes omits end_at; assume ~3h meetup
  const before = state.config.liveBeforeMs ?? DEFAULT_CONFIG.liveBeforeMs;
  const after = state.config.liveAfterMs ?? DEFAULT_CONFIG.liveAfterMs;
  return now >= start - before && now <= end + after;
}
function pollMode() {
  if (state.config.forceFastPoll) return 'force-fast';
  return inLiveWindow() ? 'live' : 'idle';
}
function effectivePollMs() {
  return inLiveWindow() ? (state.config.pollMs || DEFAULT_CONFIG.pollMs) : (state.config.idlePollMs || DEFAULT_CONFIG.idlePollMs);
}

let lastLoggedPollMode = null;
async function pollLuma() {
  if (!KEY || luma.running) return; luma.running = true;
  try {
    if (!luma.event) {
      const ev = await resolveEvent(); rememberEvent(ev);
      const gc = ev.guest_counts && ev.guest_counts.approved; if (gc) luma.total = gc.guests || 0;
      console.log(`  ◎ luma event ${ev.id} "${ev.name}"`);
    } else if (!state.config.eventStart || (luma.event.start_at && !state.config.eventEnd && Date.now() - luma.lastSync > 600_000)) {
      // Refresh schedule occasionally so a moved event updates the live window.
      try { const ev = await lumaGet('/v1/events/get', { event_id: luma.event.id }); rememberEvent(ev.event || ev); } catch {}
    }
    const mode = pollMode();
    if (mode !== lastLoggedPollMode) {
      console.log(`  ◎ poll mode → ${mode} (every ${Math.round(effectivePollMs() / 1000)}s)`);
      lastLoggedPollMode = mode;
    }
    const eventId = luma.event.id;
    const full = Date.now() - luma.fullAt > 60_000; let cursor = null, pages = 0, stop = false, count = 0;
    do {
      const j = await lumaGet('/v1/events/guests/list', { event_id: eventId, approval_status: 'approved', pagination_limit: 50, sort_column: 'checked_in_at', sort_direction: 'desc nulls last', pagination_cursor: cursor });
      for (const e of j.entries || []) {
        const g = normGuest(e); luma.guests.set(g.key, g); count++;
        if (g.checkedInAt) {
          if (!findAlloc(eventId, g.key)) {
            const a = allocate({ ...g, source: 'luma', eventId });
            console.log(`  ✓ check-in ${g.name}  → ${a.codes.map(c => c.pool + '#' + c.n).join('+') || 'no codes left'}`);
          }
        } else if (!full) stop = true;
      }
      cursor = j.next_cursor; pages++; if (!j.has_more || stop || pages > 40) break;
    } while (cursor);
    if (full) { luma.fullAt = Date.now(); luma.total = count; }
    luma.lastSync = Date.now(); luma.error = '';
  } catch (e) { luma.error = e.message; console.log(`  ✗ luma: ${e.message}`); }
  finally { luma.running = false; }
}
/** Schedule next Luma poll. Pass an explicit delay to nudge (webhook); omit to use live/idle interval. */
function schedulePoll(ms) {
  clearTimeout(luma.timer);
  const delay = ms != null ? ms : effectivePollMs();
  luma.timer = setTimeout(async () => { await pollLuma(); schedulePoll(); }, delay);
}
async function registerWebhook() {
  if (!KEY || !PUBLIC_URL) return;
  try {
    const want = `${PUBLIC_URL}/webhooks/luma`;
    const ours = ((await lumaGet('/v1/webhooks/list')).entries || []).filter(w => /\/webhooks\/luma$/.test(w.url || ''));
    const keep = ours.find(w => w.url === want && w.status === 'active');
    for (const w of ours) if (w !== keep) await lumaPost('/v1/webhooks/delete', { id: w.id }).catch(() => {});
    if (keep) console.log(`  ⚡ webhook ${keep.id} → ${want}`);
    else { const j = await lumaPost('/v2/webhooks/create', { url: want, event_types: ['guest.updated'] }); console.log(`  ⚡ webhook ${(j.webhook || j).id} → ${want}`); }
  } catch (e) { console.log(`  ⚡ webhook registration failed: ${e.message}`); }
}

// ---- Luma webhook receiver (diagnostic + nudge): logs what Luma sends, and lets the wall re-poll immediately ----
const hookLog = []; let lastWebhookAt = null;
function recordWebhook(req, b) {
  const g = b.data || {}; const tickets = g.event_tickets || [];
  const entry = {
    at: new Date().toISOString(), type: b.type || '?',
    guest: g.user_name || (g.user_email ? g.user_email.replace(/^(..).*@/, '$1…@') : g.id || null),
    approval: g.approval_status || null,
    checked_in_at: g.checked_in_at || tickets.map(t => t.checked_in_at).filter(Boolean)[0] || null,
    signature_headers: Object.keys(req.headers).filter(h => /luma|signature|secret|webhook/i.test(h)),
  };
  hookLog.unshift(entry); if (hookLog.length > 100) hookLog.pop();
  lastWebhookAt = entry.at; if (KEY && Date.now() - luma.lastSync > 1000) schedulePoll(150);
  console.log(`  ⚡ webhook ${entry.type}  ${entry.guest || ''}  approval=${entry.approval || '-'}  checked_in_at=${entry.checked_in_at || '-'}`);
  return entry;
}

const mailQueue = []; let mailBusy = false;
const ALREADY_SENT = new Set(['sent', 'dry']);   // never auto-resend these on restart
function enqueueMail(a, { force = false } = {}) {
  const at = new Date().toISOString();
  if (!emailEnabled()) { a.mail = { status: 'skipped', reason: 'email not configured', at }; return; }
  if (!isEmail(a.email)) { a.mail = { status: 'skipped', reason: 'no email', at }; return; }
  if (!a.codes.length) { a.mail = { status: 'skipped', reason: 'no codes', at }; return; }
  // Safety: a restart must never re-email guests already marked sent/dry (unless staff force-resends).
  if (!force && a.mail && ALREADY_SENT.has(a.mail.status)) return;
  if (!force && a.mail && a.mail.status === 'queued') return;
  const mk = mailKey(a);
  if (mailQueue.includes(mk)) return;
  a.mail = { status: 'queued', at, tries: (a.mail && a.mail.tries) || 0 };
  mailQueue.push(mk); pumpMail();
}
async function pumpMail() {
  if (mailBusy) { console.log(`  ✉ pump busy (queue ${mailQueue.length})`); return; } mailBusy = true;
  console.log(`  ✉ pump start (queue ${mailQueue.length})`);
  try {
    while (mailQueue.length) {
      const mk = mailQueue.shift(); const { eventId, key } = parseMailKey(mk);
      const a = findAlloc(eventId, key); if (!a) { console.log(`  ✉ skip ${mk}: no allocation`); continue; }
      // Re-check: if another path already marked sent, do not send again.
      if (a.mail && ALREADY_SENT.has(a.mail.status)) { console.log(`  ✉ skip ${mk}: already ${a.mail.status}`); continue; }
      console.log(`  ✉ sending → ${a.email} (${a.name || a.key})`);
      const tries = ((a.mail && a.mail.tries) || 0) + 1;
      try { a.mail = await Promise.race([deliver(a), sleep(90_000).then(() => ({ status: 'failed', to: a.email, at: new Date().toISOString(), error: 'send timed out' }))]); }
      catch (e) { a.mail = { status: 'failed', to: a.email, at: new Date().toISOString(), error: String(e.message || e) }; }
      a.mail.tries = tries;
      save();
      if (a.mail.status === 'failed') console.log(`  ✉ FAILED → ${a.mail.to}: ${a.mail.error}`);
      await sleep(600);
    }
  } finally { mailBusy = false; }
}
// self-heal: orphaned 'queued' after a crash/restart go back on the queue. Never touch sent/dry.
function requeueStale(all = false) {
  if (!emailEnabled()) return;
  const now = Date.now(); let n = 0;
  for (const a of state.allocations) {
    const m = a.mail;
    if (m && ALREADY_SENT.has(m.status)) continue;          // already emailed — leave alone
    if (m && m.status === 'skipped') continue;
    const transient = m && m.status === 'failed' && (m.tries || 0) < 3 && /timed out|abort|ECONN|ETIMEDOUT|network|rate limited|gave up|fetch failed/i.test(m.error || '') && now - new Date(m.at).getTime() > 60_000;
    const orphanQueued = m && m.status === 'queued' && (all || now - new Date(m.at).getTime() > 30_000);
    // Missing mail on an allocation that has codes: only queue on cold start if never attempted
    // (no status at all). Do not treat this as a resend of a completed send.
    const neverTried = !m && all;
    if (!transient && !orphanQueued && !neverTried) continue;
    if (!isEmail(a.email) || !a.codes.length) continue;
    const mk = mailKey(a);
    if (mailQueue.includes(mk)) continue;
    a.mail = { status: 'queued', at: new Date().toISOString(), tries: (m && m.tries) || 0 };
    mailQueue.push(mk); n++;
  }
  if (n) { console.log(`  ✉ re-queued ${n} stale email(s)`); save(); pumpMail(); }
}
setTimeout(() => requeueStale(true), 2000); setInterval(() => requeueStale(false), 20_000);

function allocate(body) {
  let eventId = body.eventId || currentEventId();
  if (!eventId) {
    // Manual / smoke-test path with no Luma event pinned yet.
    eventId = 'local';
    if (!state.config.eventId) { state.config.eventId = eventId; state.config.eventName = state.config.eventName || EVENT_NAME_FALLBACK || 'Local'; }
  }
  const key = String(body.key || '').trim().toLowerCase();
  if (!key) throw new Error('key required');
  const existing = findAlloc(eventId, key);
  if (existing) return existing;
  const used = usedCodeSet();
  const pick = pool => {
    const list = state.codes[pool] || [];
    const i = list.findIndex(c => !used.has(c.code));
    return i >= 0 ? { pool, code: list[i].code, url: list[i].url || referralUrl(list[i].code), n: i + 1 } : null;
  };
  const codes = [];
  if (state.config.poolMode === 'both') {
    for (const p of ['A', 'B']) { const c = pick(p); if (c) { codes.push(c); used.add(c.code); } }
  } else {
    for (const p of (state.config.poolMode === 'B-then-A' ? ['B', 'A'] : ['A', 'B'])) { const c = pick(p); if (c) { codes.push(c); break; } }
  }
  const a = {
    key, eventId, name: String(body.name || '').slice(0, 120), email: String(body.email || '').slice(0, 200),
    checkedInAt: body.checkedInAt || null, source: body.source === 'manual' ? 'manual' : 'luma',
    at: new Date().toISOString(), codes,
  };
  state.allocations.push(a);
  enqueueMail(a);
  save();
  return a;
}

/** Parse a paste of codes: CSV (code,url), one code per line, or JSON array of {code,url}/strings. */
function parseCodePaste(raw, pool = 'A') {
  const p = pool === 'B' ? 'B' : 'A';
  const out = [];
  const add = (code, url) => {
    code = String(code || '').trim();
    if (!code || /^code$/i.test(code)) return;
    out.push({ code, url: String(url || '').trim() || referralUrl(code), pool: p });
  };
  const text = String(raw || '').trim();
  if (!text) return out;
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      const list = Array.isArray(j) ? j : [...(j.A || []).map(c => ({ ...c, pool: 'A' })), ...(j.B || []).map(c => ({ ...c, pool: 'B' }))];
      for (const item of list) {
        if (typeof item === 'string') add(item, null);
        else add(item.code, item.url);
        if (item && item.pool === 'B') out[out.length - 1].pool = 'B';
      }
      return out;
    } catch { /* fall through to line parser */ }
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const parts = t.includes('\t') ? t.split('\t') : t.split(',');
    if (parts.length >= 2 && /https?:\/\//i.test(parts[1].trim())) add(parts[0], parts[1]);
    else add(parts[0].replace(/^["']|["']$/g, ''), null);
  }
  return out;
}
function addCodes(entries) {
  const have = allCodeSet();
  let added = 0, skipped = 0;
  for (const e of entries) {
    if (!e.code) continue;
    if (have.has(e.code)) { skipped++; continue; }
    const pool = e.pool === 'B' ? 'B' : 'A';
    state.codes[pool].push({ code: e.code, url: e.url || referralUrl(e.code) });
    have.add(e.code);
    added++;
  }
  if (added) save();
  return { added, skipped, pools: poolStats() };
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const publicState = () => {
  const eventId = currentEventId();
  const ps = poolStats();
  return {
    allocations: allocsFor(eventId),
    config: state.config,
    pools: { A: ps.A, B: ps.B, used: ps.used, remaining: ps.remaining },
    labels: state.codes.labels,
    lastWebhookAt,
    poll: { mode: pollMode(), nextMs: effectivePollMs(), live: inLiveWindow() },
    luma: {
      serverPolls: Boolean(KEY),
      event: luma.event || (eventId ? { id: eventId, name: state.config.eventName || null, start_at: state.config.eventStart, end_at: state.config.eventEnd } : null),
      total: luma.total, lastSync: luma.lastSync, error: luma.error,
    },
  };
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // Public liveness for uptime pingers. Touches Supabase when configured so a free-tier
    // project stays active; response never includes row data.
    if (url.pathname === '/healthz' && req.method === 'GET') {
      if (sbOn) {
        try { await sbTouch(); }
        catch { return json(res, 503, { ok: false }); }
      }
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/webhooks/luma' && req.method === 'POST') { recordWebhook(req, await readBody(req)); return json(res, 200, { ok: true }); }
    if (url.pathname.startsWith('/assets/') && req.method === 'GET') {
      const f = path.join(ROOT, 'assets', path.normalize(url.pathname.slice('/assets/'.length)).replace(/^(\.\.[/\\])+/, ''));
      if (!f.startsWith(path.join(ROOT, 'assets')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      const type = /\.jpe?g$/i.test(f) ? 'image/jpeg' : /\.png$/i.test(f) ? 'image/png' : /\.svg$/i.test(f) ? 'image/svg+xml' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' }); return fs.createReadStream(f).pipe(res);
    }
    if (!authed(req, url)) {
      if ((req.headers.accept || '').includes('text/html')) { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<title>Grok Bot</title><body style="background:#000;color:#8a8f9a;font:14px Menlo,monospace;padding:40px">● locked — open the wall with <code>?key=…</code></body>'); }
      return json(res, 401, { message: 'missing or wrong key' });
    }
    if (url.pathname === '/guests') return json(res, 200, { guests: [...luma.guests.values()] });
    if (url.pathname === '/health') {
      const ps = poolStats();
      return json(res, 200, {
        ok: true, luma: Boolean(KEY), serverPolls: Boolean(KEY), auth: Boolean(WALL_TOKEN),
        eventName: currentEventName(), eventId: state.config.eventId,
        pools: { A: ps.A, B: ps.B, remaining: ps.remaining, used: ps.used },
        email: emailInfo(),
        poll: { mode: pollMode(), nextMs: effectivePollMs(), live: inLiveWindow(), forceFastPoll: !!state.config.forceFastPoll },
      });
    }
    if (url.pathname === '/state' && req.method === 'GET') return json(res, 200, publicState());
    if (url.pathname === '/allocate' && req.method === 'POST') return json(res, 200, { allocation: allocate(await readBody(req)) });
    if (url.pathname === '/config' && req.method === 'POST') {
      const b = await readBody(req);
      const prevEvent = state.config.eventId;
      for (const k of ['eventId', 'eventName', 'eventStart', 'eventEnd', 'poolMode', 'pollMs', 'idlePollMs', 'liveBeforeMs', 'liveAfterMs', 'forceFastPoll']) {
        if (!(k in b)) continue;
        let v = b[k];
        if (k === 'forceFastPoll') v = Boolean(v);
        if (k === 'pollMs') v = Math.max(2000, Number(v) || DEFAULT_CONFIG.pollMs);
        if (k === 'idlePollMs') v = Math.max(60_000, Number(v) || DEFAULT_CONFIG.idlePollMs);
        if (k === 'liveBeforeMs' || k === 'liveAfterMs') v = Math.max(0, Number(v) || 0);
        state.config[k] = v;
      }
      save();
      lastLoggedPollMode = null;
      if (state.config.eventId !== prevEvent) {
        luma.event = null; luma.fullAt = 0; luma.guests.clear();
        for (let i = mailQueue.length - 1; i >= 0; i--) if (parseMailKey(mailQueue[i]).eventId === prevEvent) mailQueue.splice(i, 1);
      }
      if (KEY) schedulePoll(200);
      return json(res, 200, { config: state.config, poll: { mode: pollMode(), nextMs: effectivePollMs() } });
    }
    if (url.pathname === '/codes' && req.method === 'GET') return json(res, 200, { pools: poolStats(), labels: state.codes.labels, total: allCodeSet().size });
    if (url.pathname === '/codes' && req.method === 'POST') {
      const b = await readBody(req);
      const pool = b.pool === 'B' ? 'B' : 'A';
      const entries = Array.isArray(b.codes) ? b.codes.map(c => typeof c === 'string' ? { code: c, pool } : { code: c.code, url: c.url, pool: c.pool || pool })
        : parseCodePaste(b.text || b.csv || '', pool);
      const result = addCodes(entries);
      console.log(`  ⊕ codes +${result.added} (skipped ${result.skipped} dupes) · remaining ${result.pools.remaining.total}`);
      return json(res, 200, result);
    }
    if (url.pathname === '/webhooks/log') return json(res, 200, { lastWebhookAt, events: hookLog });
    if (url.pathname === '/email/send' && req.method === 'POST') {
      const b = await readBody(req); const eventId = b.eventId || currentEventId();
      const a = findAlloc(eventId, String(b.key || '').toLowerCase());
      if (!a) return json(res, 404, { message: 'no allocation for that key' });
      enqueueMail(a, { force: true }); save(); return json(res, 200, { allocation: a });
    }
    if (url.pathname === '/email/status') return json(res, 200, { busy: mailBusy, queue: [...mailQueue], version: 'v5' });
    if (url.pathname === '/email/sweep' && req.method === 'POST') { const before = mailQueue.length; requeueStale(); return json(res, 200, { queuedBefore: before, queue: [...mailQueue], busy: mailBusy }); }
    if (url.pathname === '/email/send-now' && req.method === 'POST') {
      const b = await readBody(req); const eventId = b.eventId || currentEventId();
      const a = findAlloc(eventId, String(b.key || '').toLowerCase());
      if (!a) return json(res, 404, { message: 'no allocation for that key' });
      if (!emailEnabled() || !isEmail(a.email) || !a.codes.length) return json(res, 400, { message: 'cannot send for this allocation' });
      a.mail = await deliver(a); a.mail.tries = ((a.mail && a.mail.tries) || 0) + 1; save(); return json(res, 200, { allocation: a });
    }
    if (url.pathname === '/email/test' && req.method === 'POST') {
      const b = await readBody(req); const to = String(b.to || '').trim();
      if (!isEmail(to)) return json(res, 400, { message: 'valid "to" address required' });
      if (!emailEnabled()) return json(res, 503, { message: 'email not configured (set RESEND_API_KEY, MAILGUN_*, or SMTP_USER/SMTP_PASS, or EMAIL_DRY_RUN=1)' });
      const sample = { key: 'test', name: b.name || 'Test Guest', email: to, codes: [{ pool: 'A', code: 'TEST-CODE-NOT-REAL', url: 'https://cursor.com/referral?code=TEST-CODE-NOT-REAL' }] };
      if (state.config.poolMode === 'both') sample.codes.push({ pool: 'B', code: 'POOLB-TEST-CODE', url: 'https://cursor.com/referral?code=POOLB-TEST-CODE' });
      const result = await deliver(sample, { to, tag: '[TEST] ' });
      return json(res, result.status === 'failed' ? 502 : 200, { result, info: emailInfo() });
    }
    if (url.pathname === '/release' && req.method === 'POST') {
      const b = await readBody(req); const key = String(b.key || '').toLowerCase();
      const eventId = b.eventId || currentEventId();
      const i = state.allocations.findIndex(x => x.key === key && x.eventId === eventId);
      if (i < 0) return json(res, 404, { message: 'no allocation for that key' });
      const [a] = state.allocations.splice(i, 1); save();
      console.log(`  ↩ released ${a.name || a.key} @ ${eventId}  (${a.codes.map(c => c.pool + '#' + c.n).join('+') || 'no codes'}) — back in the pool`);
      if (KEY) { luma.fullAt = 0; schedulePoll(400); }
      return json(res, 200, { ok: true, released: a });
    }
    if (url.pathname === '/reset' && req.method === 'POST') {
      // Reset only the current event's allocations; other events and the shared code inventory stay.
      const eventId = currentEventId();
      const keep = state.allocations.filter(a => a.eventId !== eventId);
      const cleared = state.allocations.length - keep.length;
      if (cleared) {
        try { fs.writeFileSync(STATE_FILE.replace(/\.json$/, `.backup-${Date.now()}.json`), JSON.stringify(state, null, 2)); } catch {}
      }
      state.allocations = keep; save(); luma.fullAt = 0; if (KEY) schedulePoll(500);
      return json(res, 200, { ok: true, cleared, eventId });
    }
    if (url.pathname.startsWith('/luma/')) {
      if (!KEY) return json(res, 503, { message: 'LUMA_API_KEY not set on the server' });
      const qs = [...url.searchParams].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      const target = LUMA + url.pathname.slice('/luma'.length) + (qs ? '?' + qs : '');
      const init = { method: req.method, headers: { 'x-luma-api-key': KEY, accept: 'application/json' } };
      if (req.method === 'POST') { init.body = JSON.stringify(await readBody(req)); init.headers['content-type'] = 'application/json'; }
      const up = await fetch(target, init);
      const text = await up.text();
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
      return res.end(text);
    }
    // static
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(ROOT, 'dist', file);
    if (!full.startsWith(path.join(ROOT, 'dist')) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const type = full.endsWith('.html') ? 'text/html; charset=utf-8' : full.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    json(res, 500, { message: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
  const ps = poolStats();
  console.log(`\n  ● Grok Bot check-in wall`);
  console.log(`    local   http://localhost:${PORT}`);
  if (lan) console.log(`    lan     http://${lan}:${PORT}   (open on a second device for the desk)`);
  console.log(`    luma    ${KEY ? `API key loaded · poll ${pollMode()} every ${Math.round(effectivePollMs() / 1000)}s (live ${Math.round((state.config.pollMs || 5000) / 1000)}s / idle ${Math.round((state.config.idlePollMs || 900000) / 1000)}s)` : 'NO API KEY → wall runs in demo mode (set LUMA_API_KEY in .env)'}`);
  console.log(`    auth    ${WALL_TOKEN ? 'token set → open /?key=' + WALL_TOKEN.slice(0, 4) + '…' : 'OPEN — set WALL_TOKEN before exposing this publicly'}`);
  if (PUBLIC_URL) console.log(`    public  ${PUBLIC_URL}`);
  console.log(`    event   ${state.config.eventId || '(auto)'} ${state.config.eventName ? `"${state.config.eventName}"` : ''}`);
  console.log(`    codes   A=${ps.A} B=${ps.B} · remaining ${ps.remaining.total} · seed ${CODES_SRC} · allocated ${state.allocations.length} across events`);
  const ei = emailInfo();
  console.log(`    email   ${!ei.enabled ? 'OFF (set RESEND_API_KEY, MAILGUN_*, or SMTP_USER/SMTP_PASS)' : ei.dryRun ? 'DRY RUN (logs only)' : (ei.provider || ei.host) + ' · from ' + ei.from + (ei.testTo ? ' · ALL mail redirected to ' + ei.testTo : '')}`);
  console.log(`    state   ${sbOn ? 'supabase · row ' + SB_ROW : path.relative(process.cwd(), STATE_FILE)}`);
  console.log(`    health  /healthz (public${sbOn ? ', touches supabase' : ''})\n`);
  if (KEY) { schedulePoll(300); registerWebhook(); }
});
