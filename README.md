# Grok Bot · Check-in Wall

A single-file Three.js "terminal" for a Grok Bot meetup: guests check in on Luma, a
full-screen ASCII Grok Bot greets each one by name on the venue screen, and every guest is
emailed a Cursor referral code (credits) the moment they check in.

Everything on screen is one WebGL character grid: a 3D Grok Bot rendered through an ASCII
shader, morphing between the eight official Grok Bot silhouettes in the brand colours; a
drifting headline and colour field on a finer grid behind it; a live check-in feed and a
block-letter welcome as overlays. Click or tap the art for an ASCII shockwave.

The server does the work: it polls Luma (and accepts its webhook), allocates one code per
guest **per event**, and emails it. The wall page is a viewer. A hidden staff console handles
lookups, resends, manual check-ins, adding codes, switching events, and a CSV export.

## Quick start (local, demo mode)

```sh
npm start                      # builds dist/index.html and serves http://localhost:8787
```

With no `.env` the wall runs a demo with fake guests and placeholder codes. Press `Space`
to fake a check-in, `F` for fullscreen.

## Running it for real

1. `cp .env.example .env` and fill in:
   - `LUMA_API_KEY` and optionally `LUMA_EVENT_ID` (`evt-…`). The event name on the wall and
     in emails comes from Luma (falling back to `EVENT_NAME`).
   - An email provider — see below. `EMAIL_FROM` must be allowed by that provider.
   - `WALL_TOKEN` — any secret; the wall is opened as `/?key=<token>`.
   - `PUBLIC_URL` — the public https URL (email hero image + Luma webhook registration).
   - `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` when hosting without a persistent disk.
2. Seed referral codes via `data/codes.json` or `CODES_JSON` (same shape as
   `data/codes.example.json`). After first boot the pool lives in the store; add more from
   the staff console without redeploying. Codes are shared across events — a code handed
   out once is never handed out again.
3. `npm start`, open `http://localhost:8787/?key=<token>` and press `F`.

Rehearsal switches: `EMAIL_DRY_RUN=1` logs instead of sending; `EMAIL_TEST_TO` redirects
every guest email to you. **Leave `EMAIL_TEST_TO` empty on event day.** Restart after editing.

## Deploy on a free host + switch events

Aimed at Render / Koyeb / similar: no persistent disk, sleeps after ~15 min without
inbound traffic, and may flag free services that make an uncommonly high volume of
outbound requests. Supabase free-tier projects pause after about a week of low DB activity.

1. Create / open the shared Supabase project and run [`supabase/schema.sql`](supabase/schema.sql)
   once in the SQL editor. It creates only namespaced `grokbot_wall_*` objects
   (`CREATE IF NOT EXISTS`, RLS on, no public policies) and does not touch other apps' tables.
2. If you still have data in the legacy `grokbot_wall_state` JSON blob, run the migration
   (see **Cutover checklist** below) before or right after deploying this build.
3. Deploy this repo as a Node web service. Start command: `npm start` (or
   `node build.mjs && node serve.mjs`). `PORT` is honored automatically.
4. Env vars to set on the host:
   - `PUBLIC_URL=https://wall.cursorpakistan.com` (or your domain)
   - `WALL_TOKEN`, `LUMA_API_KEY`, optional `LUMA_EVENT_ID`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (normalized tables; `SUPABASE_ROW_ID` only needed for the one-off blob migration)
   - `RESEND_API_KEY` + `EMAIL_FROM=Grok Bot <hello@yourdomain.com>` (or Mailgun)
   - `CODES_JSON` = minified seed JSON only for a brand-new empty DB (skip if you migrated)
   - Keep `EMAIL_TEST_TO` blank; `EMAIL_DRY_RUN=0`
   - Optional poll tuning: `POLL_MS` / `IDLE_POLL_MS` / `LIVE_BEFORE_MIN` / `LIVE_AFTER_MIN`
5. Point an uptime pinger at `https://wall.cursorpakistan.com/healthz` every ~5 minutes
   (no key required). That keeps Render awake and does one trivial Supabase read so the
   free DB stays active. Response is only `{ok:true}`.
6. Open `/?key=<WALL_TOKEN>&desk`, press `D` → **settings** to switch events or add codes.

### Cutover checklist (blob → normalized tables)

Already live on `grokbot_wall_state` (row `default`)? Do this once:

1. **Backup** — in Supabase, confirm the `grokbot_wall_state` row looks right (or download it).
2. **Apply schema** — paste/run [`supabase/schema.sql`](supabase/schema.sql) in the SQL editor
   (idempotent; leaves the blob table alone).
3. **Migrate** (preserves mail `sent`/`dry` so nobody is re-emailed; blob untouched):
   ```sh
   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… SUPABASE_ROW_ID=default \
     node scripts/migrate-to-normalized.mjs --dry-run
   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… SUPABASE_ROW_ID=default \
     node scripts/migrate-to-normalized.mjs
   ```
4. **Deploy** this build to Render (same env; no need for `SUPABASE_ROW_ID` at runtime).
5. **Smoke** — `curl $URL/healthz`, open the wall with `?key=…`, confirm check-in count and
   that a known guest still shows `sent` (desk). Spot-check Table Editor:
   `grokbot_wall_allocations` / `grokbot_wall_codes` are now browseable.
6. **Leave the blob** — do not delete `grokbot_wall_state` until you are happy; it is unused
   by this build but remains a backup.

### Luma polling (keeps outbound volume low)

The wall does **not** hit Luma every 5 s around the clock (that would look like high
outbound volume on Render free and is unnecessary between meetups):

| Mode | When | Interval |
|---|---|---|
| **live** | from `LIVE_BEFORE_MIN` before the event start until `LIVE_AFTER_MIN` after end | `POLL_MS` (~5 s) |
| **idle** | outside that window | `IDLE_POLL_MS` (~15 min) + Luma webhook |
| **force-fast** | staff checkbox in settings | same as live |

Webhooks still nudge an immediate poll at any time. Staff can turn on **force fast
polling now** from the desk if doors open early or Luma times look wrong.

### Importing a legacy `state.json` (one-off)

If you have a pre-multi-event `data/state.json` + `data/codes.json` (allocations keyed only
by email):

```sh
node scripts/import-legacy.mjs path/to/state.json path/to/codes.json \
  --event evt-MHpMKW9DxV6fTSa \
  --event-name "Cursor Pakistan Meetup" \
  --supabase
```

This tags every allocation with that event, loads the code pool (used codes stay used),
preserves mail `sent`/`dry` status so a restart will not re-email those guests, and upserts
the Supabase row. Use `--dry-run` first; `--out data/state.json` (default) writes locally;
`--merge` keeps any allocations already in the destination.

## Hosting (Docker on a box + Cloudflare tunnel)

```sh
git clone <this repo> && cd grokbot-wall
cp .env.example .env            # fill it in as above
cp data/codes.example.json data/codes.json   # then replace with your real codes
docker compose up -d --build    # wall on 127.0.0.1:8787
```

For a public https hostname without opening ports, use a Cloudflare named tunnel:
`cloudflared tunnel login`, `cloudflared tunnel create grokbot`,
`cloudflared tunnel route dns grokbot grokbot.example.com`, copy the credentials JSON into
`cloudflared/` next to a `config.yml` made from `config.example.yml`, set `PUBLIC_URL`, and
run `docker compose --profile tunnel up -d`. With `PUBLIC_URL` set the server registers a
Luma `guest.updated` webhook for itself (check-ins then show in about a second; outside
the live window the slow fallback poll is the backup). `deploy.sh` wraps the compose commands.

`WALL_TOKEN` gates every route except `/healthz`, the webhook, and `/assets`.

## Staff console

Open the wall with `&desk` in the URL and press `D`: search guests, see a guest's code and
QR, resend their email, release a code back to the pool, do a manual check-in for walk-ins,
export a CSV, change settings (event, pool mode, live/idle poll, **force fast poll**),
**add codes**, reset the **current** event's allocations only.

## Choosing an email transport

Set `EMAIL_PROVIDER` to `resend`, `mailgun`, or `smtp` to force one. If unset, **first
configured wins**: `RESEND_API_KEY` → Mailgun (`MAILGUN_API_KEY` + `MAILGUN_DOMAIN`) →
SMTP (`SMTP_USER` + `SMTP_PASS`). All three share the same queue, retries, dry-run, and
`EMAIL_TEST_TO` / `EMAIL_OFF` switches.

Use Resend or Mailgun when the host blocks outbound SMTP (Render does, on IPv4 and IPv6).
SMTP over a Gmail or Workspace app password is fine locally and on hosts that permit it.

## Dev and live on one deployment

Use a separate Supabase project, or the same project with a different current event / a
dev seed of codes. Prefer a throwaway `WALL_TOKEN` and `EMAIL_TEST_TO` on any non-live
deploy. Locally you can omit Supabase entirely (`data/state.json` file store) or set
`DATABASE_URL` to a Postgres that has had `supabase/schema.sql` applied.

| Variable | Dev | Live |
|---|---|---|
| `EMAIL_TEST_TO` | your address | *(blank)* |
| `WALL_TOKEN` | a throwaway token | the real one |
| Store | file / separate DB | shared Supabase `grokbot_wall_*` |

Check the startup banner before doors open. When `EMAIL_TEST_TO` is set it prints
`ALL mail redirected to ...`.

Smoke test (`$URL` / `$KEY`):

```sh
curl "$URL/healthz"
curl "$URL/state?key=$KEY"
curl -X POST "$URL/email/test?key=$KEY" -H 'content-type: application/json' -d '{"to":"you@example.com"}'
curl -X POST "$URL/allocate?key=$KEY" -H 'content-type: application/json' \
  -d '{"key":"smoke","name":"Smoke Test","email":"you@example.com"}'
curl -X POST "$URL/release?key=$KEY" -H 'content-type: application/json' -d '{"key":"smoke"}'
```

## Getting the codes to a host

After migration the code pool lives in `grokbot_wall_codes` (browseable in the Table Editor).
Add more from the staff console without redeploying. For a brand-new empty database,
`CODES_JSON` / `data/codes.json` still seed the pool on first boot.

## State storage

Three backends (first match wins):

1. **`DATABASE_URL`** — direct Postgres (local/CI), normalized `grokbot_wall_*` tables
2. **`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`** — same tables via PostgREST + RPC
3. **else** — `data/state.json` file (cheap local/dev fallback)

Normalized tables (all prefixed, RLS on, no public policies) — see [`supabase/schema.sql`](supabase/schema.sql):

| Table | Purpose |
|---|---|
| `grokbot_wall_events` | Luma events; `is_current` marks the active meetup |
| `grokbot_wall_codes` | Shared referral pool; `allocation_id` set ⇒ used (unique on `code`) |
| `grokbot_wall_allocations` | One row per guest per event + mail status columns |
| `grokbot_wall_settings` | Key/value config (`poolMode`, poll intervals, labels, …) |
| `grokbot_wall_state` | **Legacy JSON blob** — kept as backup after migration; unused by the app |

Code hand-out goes through Postgres function `grokbot_wall_allocate` (`FOR UPDATE SKIP LOCKED`)
so concurrent webhook + poll cannot double-assign a code. Unique `(event_id, guest_key)`
enforces one allocation per guest per event.

```sh
psql "$DATABASE_URL" -f supabase/schema.sql
# or paste into Supabase → SQL → New query
```

If Supabase/Postgres is configured but unreachable at boot the server exits rather than
start from a stale file.
## How the email queue behaves

Sends are queued at ~2/s with a timeout on each request, retries on rate limits and
transient failures, and a sweep every 20 s that re-queues anything stuck on `queued` or a
transient failure. Guests already marked `sent` or `dry` are **never** auto-requeued on
restart (staff can still force a resend from the desk). Guests with no email or no code left
are recorded as skipped. `GET /email/status`, `POST /email/sweep`, and `POST /email/send-now`
exist for emergencies.

## Keys and URL params

| key | action |
| --- | --- |
| `F` | fullscreen |
| `Space` | demo only: fake a check-in |
| `D` / `M` / `Shift+E` | with `&desk`: console, manual check-in, export CSV |

`?demo` fake guests · `?desk` staff console · `?cell=22` bigger text · `?fine=2` chunkier
backdrop glyphs · `?headline=…` override the headline · `?style=3&color=2&hold` freeze a
bot form and colour · `?raw` 3D scene without the ASCII pass.

## Layout of the repo

```
src/index.html              the wall (three.js UMD + qrcode-generator are inlined by the build)
serve.mjs                   server: static, Luma, per-event allocation, email, webhook
lib/store.mjs               file / Postgres / Supabase persistence
scripts/migrate-to-normalized.mjs  blob → normalized tables (idempotent)
scripts/import-legacy.mjs   one-off migration of legacy email-keyed state.json
supabase/schema.sql         namespaced tables + allocate RPC for a shared project
build.mjs                   → dist/index.html  (--no-codes for a public copy)
tunnel.mjs                  laptop mode: cloudflared quick tunnel + webhook lifecycle
hook-relay.mjs              exposes only the webhook path for that tunnel
assets/hero-blue.jpg        email header, from the Grok Bot brand kit
data/codes.example.json     shape of the referral-code seed file
```

## Credits

three.js (MIT) and qrcode-generator (MIT) are vendored in `src/vendor/`. The email header
image is from the Grok Bot brand kit.
