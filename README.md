# World Cup 2026 Risk Tracker

Companion to the MLB Live Tracker, scoped specifically for the FIFA World Cup 2026 (June 11 – July 19, 2026, hosted across US/Canada/Mexico).

## What it does

A single-page dashboard surfacing the markets and context a risk analyst needs during the tournament:

- **Groups** — All 12 groups laid out side-by-side. Each team’s group-winner price + qualify-from-group price visible at a glance.
- **Tournament Winner** — Outright leaderboard sorted by implied probability, with cross-book price comparison and best-price highlighting.
- **Player Props** — Top Scorer, Top Assists, Golden Glove, Player of Tournament leaderboards.
- **Matches** — Upcoming + live match h2h (home/draw/away) with favorite-cell highlighting.
- **Injuries** — Current squad news from API-Football, flagging missing-fixture and injury statuses.

Competition selector at the top lets future expansion to other tournaments (EPL, Champions League stubs already in config — flip `disabled: false` when wiring).

## Data sources (chosen for sustainability)

|Source                      |What it provides                                       |Cost                           |Notes                                                              |
|----------------------------|-------------------------------------------------------|-------------------------------|-------------------------------------------------------------------|
|`openfootball/worldcup.json`|Tournament fixtures, groups, knockout bracket structure|Free                           |Public-domain JSON, no API key, updates as draws are made          |
|The Odds API                |Match h2h + totals + every outright/futures market     |Existing $59/mo subscription   |Same key the MLB tracker uses — reuse                              |
|API-Football                |Squad rosters, current injuries, live match events     |$19/mo Pro tier (7,500 req/day)|Optional — server gracefully degrades if `API_FOOTBALL_KEY` not set|

## API request budget

With heavy server-side caching, daily API consumption is well within all tier limits:

|Endpoint                                    |Cache TTL|Daily requests at full team usage|
|--------------------------------------------|---------|---------------------------------|
|Openfootball schedule                       |24h      |~1                               |
|Odds API outrights (winner, groups, players)|60s      |~200                             |
|Odds API matches                            |60s      |~150                             |
|API-Football injuries                       |2h       |~12                              |
|API-Football squads (on demand)             |12h      |~50                              |

Total daily Odds API requests: ~350-500. Well under the 100K/month Pro tier cap. API-Football: ~100/day, well under 7,500/day Pro cap.

## Environment

```
PORT=3001               # default, override on Railway
ODDS_API_KEY=...        # required — reuse MLB tracker's key
API_FOOTBALL_KEY=...    # optional — enables injuries + squads
```

If `API_FOOTBALL_KEY` is not set, the injuries tab shows a polite “no source configured” message instead of breaking.

## Deployment

Designed to deploy on Railway as a sibling to the MLB tracker:

1. Create new Railway service from this directory
1. Set environment variables above
1. Railway auto-detects `package.json` and runs `node server.js`

```bash
# Local test
node server.js
# → World Cup tracker listening on :3001
```

## Architecture notes

- **Zero npm dependencies.** Same approach as MLB tracker — pure Node stdlib (`http`, `https`, `url`, `fs`). Survives `npm` outages.
- **No optional chaining on subscripts** (`obj?.[key]` patterns avoided in server). Files survive copy-paste through markdown-aware tools like Slack/Discord without corruption.
- **In-memory cache** with tiered TTLs. Restart-safe (just re-warms in the first minute).
- **Static fixture data** is fetched once from openfootball and cached for 24h. The tournament schedule doesn’t change once knockout brackets are set, and bracket resolutions get picked up on the next 24h cache cycle.
- **Competition selector is config-driven.** Adding EPL or Champions League is one entry in the `COMPETITIONS` map — no other code changes required for outright/match markets. (Live in-play events would need additional shaping.)

## Pre-tournament vs in-tournament use

The tool is designed to be useful **right now** (months before kickoff) and continue serving during the tournament:

**Pre-tournament** (now → June 11):

- Tournament Winner board moves as squad announcements drop
- Group Winner / Qualify markets move on draw, friendlies, injury news
- Player Props move as managers signal who’s getting minutes
- Injuries tab tracks who’s questionable for tournament selection

**In-tournament** (June 11 → July 19):

- Matches tab populates with daily fixtures + live h2h odds
- Group markets update after each matchday as paths to qualification clarify
- Outrights re-price after every result
- Injuries flag new in-tournament issues

## Future expansion

Stubs already in `COMPETITIONS` for EPL, Champions League. To enable post-World-Cup:

1. Flip `disabled: false` in the relevant entry
1. Verify the Odds API sport key still matches their current API (they occasionally rename)
1. Verify API-Football league ID and season for current campaign

The frontend competition selector and per-view rendering already handle any competition that returns the standard data shapes.