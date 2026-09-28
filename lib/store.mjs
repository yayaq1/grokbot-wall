/**
 * Persistence for the check-in wall.
 *
 * Backends (first match wins):
 *   1. DATABASE_URL  — direct Postgres (local / CI), uses normalized grokbot_wall_* tables
 *   2. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — PostgREST against the same tables
 *   3. else — data/state.json file (dev fallback; same in-memory shape)
 *
 * The in-memory `state` shape is unchanged from the blob era so the rest of serve.mjs
 * can stay mostly the same; mutations that must be race-safe go through allocateAtomic().
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const referralUrl = (code) => `https://cursor.com/referral?code=${encodeURIComponent(code)}`;

export function createStore({
  root,
  stateFile,
  seedCodes,
  defaultConfig,
  sbUrl = '',
  sbKey = '',
  databaseUrl = process.env.DATABASE_URL || '',
}) {
  const filePath = stateFile || path.join(root, 'data/state.json');
  const restOn = Boolean(sbUrl && sbKey);
  const pgOn = Boolean(databaseUrl);
  const mode = pgOn ? 'postgres' : restOn ? 'supabase' : 'file';

  let pool = null;
  const sbHeaders = restOn
    ? { apikey: sbKey, authorization: `Bearer ${sbKey}`, 'content-type': 'application/json', prefer: 'return=representation' }
    : null;

  async function pgQuery(text, params) {
    if (!pool) pool = new pg.Pool({ connectionString: databaseUrl });
    return pool.query(text, params);
  }

  async function rest(pathname, { method = 'GET', body, headers = {} } = {}) {
    const r = await fetch(`${sbUrl}/rest/v1/${pathname}`, {
      method,
      headers: { ...sbHeaders, ...headers },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!r.ok) {
      const err = new Error(`${r.status} ${typeof json === 'object' ? JSON.stringify(json).slice(0, 300) : String(json).slice(0, 300)}`);
      err.status = r.status;
      throw err;
    }
    return json;
  }

  async function rpc(name, args) {
    if (pgOn) {
      const keys = Object.keys(args);
      const cols = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      const r = await pgQuery(`select public.${name}(${cols}) as result`, keys.map(k => args[k]));
      return r.rows[0]?.result ?? null;
    }
    return rest(`rpc/${name}`, { method: 'POST', body: args });
  }

  function emptyState() {
    return {
      version: 3,
      allocations: [],
      codes: {
        A: (seedCodes.A || []).map((x, i) => ({ code: x.code, url: x.url || referralUrl(x.code), n: i + 1 })),
        B: (seedCodes.B || []).map((x, i) => ({ code: x.code, url: x.url || referralUrl(x.code), n: i + 1 })),
        labels: { ...(seedCodes.labels || { A: 'Pool A', B: 'Pool B' }) },
      },
      config: { ...defaultConfig },
    };
  }

  function normalizeFile(raw) {
    const s = emptyState();
    if (!raw) return s;
    s.allocations = Array.isArray(raw.allocations) ? raw.allocations.map(a => ({ ...a })) : [];
    if (raw.codes?.A && raw.codes?.B) {
      s.codes = {
        A: raw.codes.A.map((x, i) => ({ code: x.code, url: x.url || referralUrl(x.code), n: x.n || i + 1 })),
        B: raw.codes.B.map((x, i) => ({ code: x.code, url: x.url || referralUrl(x.code), n: x.n || i + 1 })),
        labels: { ...s.codes.labels, ...(raw.codes.labels || {}) },
      };
    }
    s.config = { ...defaultConfig, ...(raw.config || {}) };
    if (!s.config.eventId && process.env.LUMA_EVENT_ID) s.config.eventId = process.env.LUMA_EVENT_ID;
    const fb = s.config.eventId;
    for (const a of s.allocations) if (!a.eventId && fb) a.eventId = fb;
    // Merge seed codes not already present
    const have = new Set([...s.codes.A, ...s.codes.B].map(c => c.code));
    for (const pool of ['A', 'B']) {
      for (const c of seedCodes[pool] || []) {
        if (!c?.code || have.has(c.code)) continue;
        s.codes[pool].push({ code: c.code, url: c.url || referralUrl(c.code), n: s.codes[pool].length + 1 });
        have.add(c.code);
      }
    }
    return s;
  }

  async function loadFromDb() {
    const state = emptyState();
    let settingsRows, eventRows, codeRows, allocRows;

    if (pgOn) {
      [settingsRows, eventRows, codeRows, allocRows] = await Promise.all([
        pgQuery('select key, value from public.grokbot_wall_settings'),
        pgQuery('select * from public.grokbot_wall_events'),
        pgQuery('select * from public.grokbot_wall_codes order by pool, position'),
        pgQuery('select * from public.grokbot_wall_allocations'),
      ]);
      settingsRows = settingsRows.rows;
      eventRows = eventRows.rows;
      codeRows = codeRows.rows;
      allocRows = allocRows.rows;
    } else {
      [settingsRows, eventRows, codeRows, allocRows] = await Promise.all([
        rest('grokbot_wall_settings?select=key,value'),
        rest('grokbot_wall_events?select=*'),
        rest('grokbot_wall_codes?select=*&order=pool.asc,position.asc'),
        rest('grokbot_wall_allocations?select=*'),
      ]);
    }

    const settings = Object.fromEntries((settingsRows || []).map(r => [r.key, r.value]));
    for (const [k, v] of Object.entries(settings)) {
      if (k === 'labels' && v && typeof v === 'object') state.codes.labels = { ...state.codes.labels, ...v };
      else if (k === 'schema_version') continue;
      else if (k in defaultConfig || ['eventId', 'eventName', 'eventStart', 'eventEnd'].includes(k)) {
        state.config[k] = v;
      }
    }

    const current = (eventRows || []).find(e => e.is_current);
    if (current) {
      state.config.eventId = current.id;
      state.config.eventName = current.name || state.config.eventName || '';
      state.config.eventStart = current.start_at || null;
      state.config.eventEnd = current.end_at || null;
    }

    if (codeRows?.length) {
      state.codes.A = [];
      state.codes.B = [];
      for (const c of codeRows) {
        const entry = { code: c.code, url: c.url || referralUrl(c.code), n: c.position };
        if (c.pool === 'B') state.codes.B.push(entry);
        else state.codes.A.push(entry);
      }
    } else {
      // First boot on empty DB: seed codes into tables.
      await seedCodesIntoDb(state.codes);
    }

    const codesByAlloc = new Map();
    for (const c of codeRows || []) {
      if (!c.allocation_id) continue;
      const list = codesByAlloc.get(c.allocation_id) || [];
      list.push({ pool: c.pool, code: c.code, url: c.url, n: c.position });
      codesByAlloc.set(c.allocation_id, list);
    }

    state.allocations = (allocRows || []).map(a => {
      const mail = a.mail_status ? {
        status: a.mail_status,
        to: a.mail_to || undefined,
        at: a.mail_at || undefined,
        tries: a.mail_tries || 0,
        error: a.mail_error || undefined,
        reason: a.mail_reason || undefined,
        id: a.mail_provider_id || undefined,
      } : null;
      return {
        id: a.id,
        key: a.guest_key,
        eventId: a.event_id,
        name: a.name || '',
        email: a.email || '',
        checkedInAt: a.checked_in_at || null,
        source: a.source || 'luma',
        at: a.allocated_at,
        codes: codesByAlloc.get(a.id) || [],
        mail,
      };
    });

    return state;
  }

  async function seedCodesIntoDb(codes) {
    const rows = [];
    for (const pool of ['A', 'B']) {
      (codes[pool] || []).forEach((c, i) => {
        rows.push({ code: c.code, pool, url: c.url || referralUrl(c.code), position: c.n || i + 1 });
      });
    }
    if (!rows.length) return;
    if (pgOn) {
      for (const r of rows) {
        await pgQuery(
          `insert into public.grokbot_wall_codes (code, pool, url, position)
           values ($1,$2,$3,$4) on conflict (code) do nothing`,
          [r.code, r.pool, r.url, r.position],
        );
      }
    } else {
      // Upsert in chunks
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        await rest('grokbot_wall_codes?on_conflict=code', {
          method: 'POST',
          headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: chunk,
        });
      }
    }
    if (codes.labels) await setSetting('labels', codes.labels);
    await setSetting('schema_version', 3);
  }

  async function setSetting(key, value) {
    if (pgOn) {
      await pgQuery(
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

  async function load() {
    if (mode === 'file') {
      try { return normalizeFile(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
      catch { return normalizeFile(null); }
    }
    try {
      return await loadFromDb();
    } catch (e) {
      const err = new Error(`store load failed (${mode}): ${e.message}`);
      err.cause = e;
      throw err;
    }
  }

  function saveFile(state) {
    try { fs.writeFileSync(filePath, JSON.stringify(state, null, 2)); }
    catch (e) { console.error(`  ✗ state file write failed: ${e.message}`); }
  }

  /** Persist config keys + current event flag. Does not rewrite allocations/codes. */
  async function saveConfig(config) {
    if (mode === 'file') return;
    const keys = ['poolMode', 'pollMs', 'idlePollMs', 'liveBeforeMs', 'liveAfterMs', 'forceFastPoll',
      'eventId', 'eventName', 'eventStart', 'eventEnd'];
    for (const k of keys) {
      if (k in config) await setSetting(k, config[k]);
    }
    if (config.eventId) {
      await upsertEvent({
        id: config.eventId,
        name: config.eventName || '',
        start_at: config.eventStart || null,
        end_at: config.eventEnd || null,
        is_current: true,
      });
    }
  }

  async function upsertEvent({ id, name, start_at, end_at, is_current }) {
    if (mode === 'file' || !id) return;
    if (pgOn) {
      if (is_current) await pgQuery('update public.grokbot_wall_events set is_current = false where is_current');
      await pgQuery(
        `insert into public.grokbot_wall_events (id, name, start_at, end_at, is_current, updated_at)
         values ($1,$2,$3,$4,coalesce($5,false), now())
         on conflict (id) do update set
           name = case when excluded.name <> '' then excluded.name else grokbot_wall_events.name end,
           start_at = coalesce(excluded.start_at, grokbot_wall_events.start_at),
           end_at = coalesce(excluded.end_at, grokbot_wall_events.end_at),
           is_current = coalesce($5, grokbot_wall_events.is_current),
           updated_at = now()`,
        [id, name || '', start_at, end_at, is_current ?? null],
      );
      return;
    }
    if (is_current) {
      // Clear other current flags then upsert.
      const others = await rest('grokbot_wall_events?is_current=eq.true&select=id');
      for (const o of others || []) {
        if (o.id === id) continue;
        await rest(`grokbot_wall_events?id=eq.${encodeURIComponent(o.id)}`, {
          method: 'PATCH', headers: { prefer: 'return=minimal' }, body: { is_current: false },
        });
      }
    }
    await rest('grokbot_wall_events?on_conflict=id', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: [{
        id, name: name || '', start_at: start_at || null, end_at: end_at || null,
        is_current: !!is_current, updated_at: new Date().toISOString(),
      }],
    });
  }

  async function allocateAtomic(body, config) {
    const eventId = body.eventId || config.eventId;
    if (!eventId) throw new Error('event_id required');
    const key = String(body.key || '').trim().toLowerCase();
    if (!key) throw new Error('key required');

    if (mode === 'file') {
      // Caller handles in-memory allocate for file mode.
      return null;
    }

    const result = await rpc('grokbot_wall_allocate', {
      p_event_id: eventId,
      p_guest_key: key,
      p_name: String(body.name || '').slice(0, 120),
      p_email: String(body.email || '').slice(0, 200),
      p_checked_in_at: body.checkedInAt || null,
      p_source: body.source === 'manual' ? 'manual' : 'luma',
      p_luma_guest_id: body.id || body.lumaGuestId || null,
      p_pool_mode: config.poolMode || 'A-then-B',
      p_event_name: config.eventName || '',
    });
    return result;
  }

  async function updateMail(allocation) {
    if (mode === 'file' || !allocation) return;
    const m = allocation.mail || {};
    const patch = {
      mail_status: m.status || null,
      mail_to: m.to || null,
      mail_at: m.at || null,
      mail_tries: m.tries || 0,
      mail_error: m.error || null,
      mail_reason: m.reason || null,
      mail_provider_id: m.id || null,
    };
    if (pgOn) {
      if (allocation.id) {
        await pgQuery(
          `update public.grokbot_wall_allocations set
             mail_status=$2, mail_to=$3, mail_at=$4, mail_tries=$5,
             mail_error=$6, mail_reason=$7, mail_provider_id=$8
           where id=$1`,
          [allocation.id, patch.mail_status, patch.mail_to, patch.mail_at, patch.mail_tries,
            patch.mail_error, patch.mail_reason, patch.mail_provider_id],
        );
      } else {
        await pgQuery(
          `update public.grokbot_wall_allocations set
             mail_status=$3, mail_to=$4, mail_at=$5, mail_tries=$6,
             mail_error=$7, mail_reason=$8, mail_provider_id=$9
           where event_id=$1 and guest_key=$2`,
          [allocation.eventId, allocation.key, patch.mail_status, patch.mail_to, patch.mail_at,
            patch.mail_tries, patch.mail_error, patch.mail_reason, patch.mail_provider_id],
        );
      }
      return;
    }
    const filter = allocation.id
      ? `id=eq.${allocation.id}`
      : `event_id=eq.${encodeURIComponent(allocation.eventId)}&guest_key=eq.${encodeURIComponent(allocation.key)}`;
    await rest(`grokbot_wall_allocations?${filter}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' }, body: patch,
    });
  }

  async function release(eventId, key) {
    if (mode === 'file') return null;
    return rpc('grokbot_wall_release', { p_event_id: eventId, p_guest_key: key });
  }

  async function resetEvent(eventId) {
    if (mode === 'file' || !eventId) return 0;
    if (pgOn) {
      // Free codes belonging to this event's allocations, then delete allocs.
      const r = await pgQuery(
        `with doomed as (
           select id from public.grokbot_wall_allocations where event_id = $1
         ), freed as (
           update public.grokbot_wall_codes c
           set allocation_id = null, used_at = null
           from doomed d where c.allocation_id = d.id
         )
         delete from public.grokbot_wall_allocations where event_id = $1
         returning id`,
        [eventId],
      );
      return r.rowCount || 0;
    }
    const allocs = await rest(`grokbot_wall_allocations?event_id=eq.${encodeURIComponent(eventId)}&select=id`);
    for (const a of allocs || []) {
      await rest(`grokbot_wall_codes?allocation_id=eq.${a.id}`, {
        method: 'PATCH', headers: { prefer: 'return=minimal' },
        body: { allocation_id: null, used_at: null },
      });
    }
    await rest(`grokbot_wall_allocations?event_id=eq.${encodeURIComponent(eventId)}`, {
      method: 'DELETE', headers: { prefer: 'return=minimal' },
    });
    return (allocs || []).length;
  }

  async function addCodes(entries) {
    if (mode === 'file') return null; // caller updates memory + file
    // Determine next position per pool
    let nextA = 1, nextB = 1;
    if (pgOn) {
      const r = await pgQuery(
        `select pool, coalesce(max(position),0) as m from public.grokbot_wall_codes group by pool`,
      );
      for (const row of r.rows) {
        if (row.pool === 'A') nextA = row.m + 1;
        if (row.pool === 'B') nextB = row.m + 1;
      }
    } else {
      const rows = await rest('grokbot_wall_codes?select=pool,position');
      for (const row of rows || []) {
        if (row.pool === 'A') nextA = Math.max(nextA, (row.position || 0) + 1);
        if (row.pool === 'B') nextB = Math.max(nextB, (row.position || 0) + 1);
      }
    }
    let added = 0, skipped = 0;
    const toInsert = [];
    const seen = new Set();
    for (const e of entries) {
      if (!e.code || seen.has(e.code)) { if (e.code) skipped++; continue; }
      seen.add(e.code);
      const pool = e.pool === 'B' ? 'B' : 'A';
      const position = pool === 'B' ? nextB++ : nextA++;
      toInsert.push({ code: e.code, pool, url: e.url || referralUrl(e.code), position });
    }
    if (!toInsert.length) return { added: 0, skipped };
    if (pgOn) {
      for (const r of toInsert) {
        const res = await pgQuery(
          `insert into public.grokbot_wall_codes (code, pool, url, position)
           values ($1,$2,$3,$4) on conflict (code) do nothing returning code`,
          [r.code, r.pool, r.url, r.position],
        );
        if (res.rowCount) added++; else skipped++;
      }
    } else {
      // Try insert; duplicates ignored
      try {
        await rest('grokbot_wall_codes?on_conflict=code', {
          method: 'POST',
          headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
          body: toInsert,
        });
        // recount: approximate
        added = toInsert.length; // may overcount if dupes; refresh from caller
      } catch {
        for (const r of toInsert) {
          try {
            await rest('grokbot_wall_codes', {
              method: 'POST', headers: { prefer: 'return=minimal' }, body: r,
            });
            added++;
          } catch { skipped++; }
        }
      }
    }
    return { added, skipped };
  }

  async function touch() {
    if (mode === 'file') return true;
    if (pgOn) {
      await pgQuery('select key from public.grokbot_wall_settings limit 1');
      return true;
    }
    await rest('grokbot_wall_settings?select=key&limit=1');
    return true;
  }

  async function close() {
    if (pool) { await pool.end(); pool = null; }
  }

  return {
    mode, filePath, saveFile, load, saveConfig, upsertEvent,
    allocateAtomic, updateMail, release, resetEvent, addCodes, touch, close, setSetting,
    restOn, pgOn,
  };
}
