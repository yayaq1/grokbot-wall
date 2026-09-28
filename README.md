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

Aimed at Render / Koyeb / similar: no persistent disk, may sleep when idle, outbound SMTP
often blocked.

1. Create a Supabase project and run the SQL below once.
2. Deploy this repo as a Node web service. Start command: `npm start` (or
   `node build.mjs && node serve.mjs`). Set `PORT` is honored automatically.
3. Env vars to set on the host:
   - `PUBLIC_URL=https://wall.cursorpakistan.com` (or your domain)
   - `WALL_TOKEN`, `LUMA_API_KEY`, optional `LUMA_EVENT_ID`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ROW_ID=default`
   - `RESEND_API_KEY` + `EMAIL_FROM=Grok Bot <hello@yourdomain.com>` (or Mailgun)
   - `CODES_JSON` = minified seed JSON (or import legacy data first — see below)
   - Keep `EMAIL_TEST_TO` blank; `EMAIL_DRY_RUN=0`
4. Point an uptime pinger at `https://wall.cursorpakistan.com/healthz` (no key required)
   so the free instance stays awake through the meetup.
5. Open `https://wall.cursorpakistan.com/?key=<WALL_TOKEN>&desk`, press `D` → **settings**,
   pick the Luma event from the dropdown, Save. The choice is stored in Supabase and
   survives sleeps / redeploys. To run the next meetup: pick the new event — the wall and
   console show only that event's check-ins; past events stay viewable/exportable by
   switching back. The same person at a new event gets a new code.
6. To top up codes mid-season: settings → paste a list or CSV → **add codes**. Remaining
   count is shown in the desk header and settings.

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
Luma `guest.updated` webhook for itself (check-ins then show in about a second; polling
every 5 s is the fallback). `deploy.sh` wraps the compose commands.

`WALL_TOKEN` gates every route except `/healthz`, the webhook, and `/assets`.

## Staff console

Open the wall with `&desk` in the URL and press `D`: search guests, see a guest's code and
QR, resend their email, release a code back to the pool, do a manual check-in for walk-ins,
export a CSV, change settings (event, pool mode, poll interval), **add codes**, reset the
**current** event's allocations only.

## Choosing an email transport

Set `EMAIL_PROVIDER` to `resend`, `mailgun`, or `smtp` to force one. If unset, **first
configured wins**: `RESEND_API_KEY` → Mailgun (`MAILGUN_API_KEY` + `MAILGUN_DOMAIN`) →
SMTP (`SMTP_USER` + `SMTP_PASS`). All three share the same queue, retries, dry-run, and
`EMAIL_TEST_TO` / `EMAIL_OFF` switches.

Use Resend or Mailgun when the host blocks outbound SMTP (Render does, on IPv4 and IPv6).
SMTP over a Gmail or Workspace app password is fine locally and on hosts that permit it.

## Dev and live on one deployment

The wall has no build-time modes: a dev deployment is the same image with different env vars.
`SUPABASE_ROW_ID` is the important one — dev and live read separate rows of `wall_state`, so a
test check-in can never consume a code from the real allocation list.

| Variable | Dev | Live |
|---|---|---|
| `SUPABASE_ROW_ID` | `dev` | `default` |
| `EMAIL_TEST_TO` | your address | *(blank)* |
| `WALL_TOKEN` | a throwaway token | the real one |
| `CODES_JSON` / seed | placeholders or a small set | the real pool |

Going live is editing those in the host's dashboard and redeploying. Nothing is rebuilt.

Check the startup banner before doors open. It prints the row in use and, when
`EMAIL_TEST_TO` is set, `ALL mail redirected to ...` — if you see that line on event day, every
guest email is going to you instead of to guests.

Smoke test a deployment (`$URL` and `$KEY` being the host URL and `WALL_TOKEN`):

```sh
curl "$URL/healthz"                                      # public liveness
curl "$URL/state?key=$KEY"                               # luma.error empty, guest total sane
curl -X POST "$URL/email/test?key=$KEY" -H 'content-type: application/json' -d '{"to":"you@example.com"}'
curl -X POST "$URL/allocate?key=$KEY" -H 'content-type: application/json' \
  -d '{"key":"smoke","name":"Smoke Test","email":"you@example.com"}'
curl -X POST "$URL/release?key=$KEY" -H 'content-type: application/json' -d '{"key":"smoke"}'
```

The last line returns the code to the pool, so a smoke test costs nothing.

## Getting the codes to a host

`data/codes.json` is gitignored and is not copied into the image, so a deployed container has
only the placeholders unless you set `CODES_JSON` or import into Supabase. After the first
save, the pool is in the store; further codes are added from the staff console (`POST /codes`).

Malformed seed JSON, or JSON without `A` and `B` arrays, exits at boot rather than starting a
wall that cannot hand out codes.

## State storage

By default the server keeps allocations (and the code pool, and the current event) in
`data/state.json`. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` and it keeps them in
Postgres instead, which is what makes a host with no persistent disk safe — the wall reloads
after any restart or sleep. The JSON file is still written when the disk allows, as a local
cache.

Create the table once, in the Supabase SQL editor:

```sql
create table if not exists wall_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table wall_state enable row level security;
```

The `data` jsonb document is versioned by the app (`version: 2`). Shape:

```json
{
  "version": 2,
  "config": { "eventId": "evt-…", "eventName": "…", "poolMode": "A-then-B", "pollMs": 5000 },
  "codes": { "A": [{ "code": "…", "url": "…" }], "B": [], "labels": { "A": "Pool A", "B": "Pool B" } },
  "allocations": [
    { "key": "guest@email", "eventId": "evt-…", "name": "…", "email": "…", "codes": […], "mail": { "status": "sent" } }
  ]
}
```

No RLS policies are needed: the service role key bypasses RLS, and without a policy the anon key
can read nothing. If Supabase is configured but unreachable at boot the server exits rather than
start from a stale file, since that would re-issue codes guests already have.

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
src/index.html           the wall (three.js UMD + qrcode-generator are inlined by the build)
serve.mjs                server: static, Luma, per-event allocation, email, webhook
scripts/import-legacy.mjs  one-off migration of legacy state.json + codes.json
build.mjs                → dist/index.html  (--no-codes for a public copy)
tunnel.mjs               laptop mode: cloudflared quick tunnel + webhook lifecycle
hook-relay.mjs           exposes only the webhook path for that tunnel
assets/hero-blue.jpg     email header, from the Grok Bot brand kit
data/codes.example.json  shape of the referral-code seed file
```

## Credits

three.js (MIT) and qrcode-generator (MIT) are vendored in `src/vendor/`. The email header
image is from the Grok Bot brand kit.
