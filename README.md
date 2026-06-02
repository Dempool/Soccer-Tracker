# World Cup 2026 Risk Tracker

Companion to the MLB Live Tracker, scoped specifically for the FIFA World Cup 2026 (June 11 – July 19, 2026, hosted across US/Canada/Mexico).

## What it does

A single-page dashboard surfacing the markets and context a risk analyst needs during the tournament:

- **Groups** — All 12 groups laid out side-by-side. Each team's group-winner price + qualify-from-group price visible at a glance.
- **Tournament Winner** — Outright leaderboard sorted by implied probability, with cross-book price comparison and best-price highlighting.
- **Player Props** — Top Scorer, Top Assists, Golden Glove, Player of Tournament leaderboards.
- **Matches** — Upcoming + live match h2h (home/draw/away) with favorite-cell highlighting.
- **Injuries** — Current squad news from API-Football, flagging missing-fixture and injury statuses.

Competition selector at the top lets future expansion to other tournaments (EPL, Champions League stubs already in config — flip `disabled: false` when wiring).

## Data sources (chosen for sustainability)

| Source | What it provides | Cost | Notes |
|---|---|---|---|
| `openfootball/worldcup.json` | Tournament fixtures, groups, knockout bracket structure | Free | Public-domain JSON, no API key, updates as draws are made |
| The Odds API | Match h2h + totals + every outright/futures market | Existing $59/mo subscription | Same key the MLB tracker uses — reuse |
| API-Football | Squad rosters, current injuries, live match events | $19/mo Pro tier (7,500 req/day) | Optional — server gracefully degrades if `API_FOOTBALL_KEY` not set |

## API request budget

With heavy server-side caching, daily API consumption is well within all tier limits:

| Endpoint | Cache TTL | Daily requests at full team usage |
|---|---|---|
| Openfootball schedule | 24h | ~1 |
| Odds API outrights (winner, groups, players) | 60s | ~200 |
| Odds API matches | 60s | ~150 |
| API-Football injuries | 2h | ~12 |
| API-Football squads (on demand) | 12h | ~50 |

Total daily Odds API requests: ~350-500. Well under the 100K/month Pro tier cap. API-Football: ~100/day, well under 7,500/day Pro cap.

---

## Deploying to Railway

This repo is configured to deploy on Railway with zero manual setup — the config files do the work.

### Files Railway uses

| File | Purpose |
|---|---|
| `package.json` | Declares Node engine + `start` script |
| `railway.toml` | Sets healthcheck path, start command, restart policy |
| `nixpacks.toml` | Pins Node 20 so builds stay reproducible |
| `.railwayignore` | Excludes dev files from the deploy bundle |

### Step-by-step

1. **Push this folder to a Git repo** (separate from the MLB tracker is fine — Railway connects per-service).

2. **In Railway, create a new service from this repo.**
   - Railway auto-detects Node from `package.json` and `nixpacks.toml`
   - Build command: auto (`npm install` runs, but since there are zero deps it's instant)
   - Start command: `node server.js` (set in `railway.toml`)

3. **Set environment variables** in the Railway dashboard → Variables:

   ```
   ODDS_API_KEY=...        # Reuse the same key from your MLB tracker
   API_FOOTBALL_KEY=...    # Optional — enables Injuries tab
   ```

   `PORT` is set automatically by Railway — the server reads `process.env.PORT`.

4. **Deploy.** Railway pings `/healthz` before routing traffic. Once that returns 200 (usually within 5-10 seconds of boot), the new deployment is live.

5. **Generate a public URL** under Settings → Networking → "Generate Domain". You'll get something like `wc-tracker-production.up.railway.app`.

### Verifying the deploy

```bash
# Healthcheck
curl https://your-app.up.railway.app/healthz
# → {"status":"ok","uptime":12.3}

# Competitions list
curl https://your-app.up.railway.app/api/competitions
# → {"competitions":[{"id":"world_cup_2026","label":"World Cup 2026"}]}

# Env sanity check
curl https://your-app.up.railway.app/api/debug
# → {"oddsApiKeySet":true,"apiFootballKeySet":true,...}
```

If `oddsApiKeySet` shows `false`, the env var didn't apply — double-check Railway's Variables tab and redeploy.

### Restart / shutdown behavior

The server handles `SIGTERM` gracefully — Railway sends this during deploys, and the server waits up to 10 seconds for in-flight requests to drain before exiting. Hard timeout at 10s prevents stuck deploys.

`uncaughtException` and `unhandledRejection` are logged but don't crash the process — Railway will see continued healthcheck success and not trigger an unnecessary restart.

### Restart policy

`railway.toml` sets `restartPolicyType = "ON_FAILURE"` with max 10 retries. If the container crashes 10 times in a row (rare), Railway stops restarting and surfaces the failure. Healthy crashes restart immediately.

---

## Local development

```bash
# No npm install needed — zero dependencies
node server.js

# Override port if conflicting
PORT=4000 node server.js

# With local env vars
ODDS_API_KEY=xxx API_FOOTBALL_KEY=yyy node server.js
```

Then open `http://localhost:3001` (or whatever PORT you set).

---

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `PORT` | No (Railway sets it) | TCP port to listen on. Defaults to 3001 locally |
| `ODDS_API_KEY` | Yes (for market data) | The Odds API key. Without this, market endpoints return errors |
| `API_FOOTBALL_KEY` | No | API-Football v3 key. Without this, Injuries tab shows "no source configured" gracefully |

If `API_FOOTBALL_KEY` is not set, the injuries tab shows a polite "no source configured" message instead of breaking.

---

## Architecture notes

- **Zero npm dependencies.** Same approach as MLB tracker — pure Node stdlib (`http`, `https`, `url`, `fs`). Survives `npm` outages and keeps builds instant.
- **No optional chaining on subscripts** (`obj?.[key]` patterns avoided in server). Files survive copy-paste through markdown-aware tools like Slack/Discord without corruption.
- **In-memory cache** with tiered TTLs. Restart-safe (just re-warms in the first minute after deploy).
- **Static fixture data** is fetched once from openfootball and cached for 24h. The tournament schedule doesn't change once knockout brackets are set, and bracket resolutions get picked up on the next 24h cache cycle.
- **Competition selector is config-driven.** Adding EPL or Champions League is one entry in the `COMPETITIONS` map — no other code changes required for outright/match markets.

## Pre-tournament vs in-tournament use

The tool is designed to be useful **right now** (months before kickoff) and continue serving during the tournament:

**Pre-tournament** (now → June 11):
- Tournament Winner board moves as squad announcements drop
- Group Winner / Qualify markets move on draw, friendlies, injury news
- Player Props move as managers signal who's getting minutes
- Injuries tab tracks who's questionable for tournament selection

**In-tournament** (June 11 → July 19):
- Matches tab populates with daily fixtures + live h2h odds
- Group markets update after each matchday as paths to qualification clarify
- Outrights re-price after every result
- Injuries flag new in-tournament issues

## Future expansion

Stubs already in `COMPETITIONS` for EPL, Champions League. To enable post-World-Cup:

1. Flip `disabled: false` in the relevant entry
2. Verify the Odds API sport key still matches their current API (they occasionally rename)
3. Verify API-Football league ID and season for current campaign

The frontend competition selector and per-view rendering already handle any competition that returns the standard data shapes.
