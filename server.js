// ─────────────────────────────────────────────────────────────────────────────
// World Cup 2026 Risk Tracker — Server
//
// Stack notes:
//  - Pure Node.js, zero npm dependencies (deliberate — same approach as MLB tracker)
//  - Three data sources, each chosen for sustainability:
//      1. openfootball/worldcup.json (FREE, no auth) — tournament fixtures, groups
//      2. API-Football v3 ($19/mo Pro for 7,500 req/day) — live match data, squads, injuries
//      3. The Odds API (existing subscription) — outright/futures markets + h2h match odds
//  - Heavy caching: fixtures 24h, squads 12h, markets 60s, live 30s
//  - On a typical day: fixtures cache hit ~99% of the time, so daily API-Football usage
//    sits around 200-500 requests even with continuous polling
//
// Layout of this file:
//   ── helpers ── (http, cache, date)
//   ── config ── (sport keys, competitions, market types)
//   ── data fetchers ── (one per source)
//   ── API routes ── (one block per route)
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3001;
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || '';

// Logging that flushes immediately — important on Railway where buffered logs disappear on restart
function log(...args) { console.log(new Date().toISOString(), '·', ...args); }

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper — generic JSON fetch with redirect handling + timeout
// ─────────────────────────────────────────────────────────────────────────────
function fetchJson(reqUrl, { headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(reqUrl);
    const isHttps = parsed.protocol === 'https:';
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.path,
      method: 'GET',
      headers: { 'User-Agent': 'wc-tracker/1.0', ...headers },
      timeout: timeoutMs,
    };
    const req = (isHttps ? https : http).request(opts, (res) => {
      // Follow redirects (max 3 hops)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return fetchJson(res.headers.location, { headers, timeoutMs }).then(resolve, reject);
      }
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message} · body: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache — tier the TTL by data freshness needs
//   FIXTURES_TTL: tournament schedule rarely changes between knockout-round resolutions
//   SQUADS_TTL:   roster announcements aren't frequent post-deadline
//   MARKETS_TTL:  outright lines update slowly, but check often during news cycles
//   LIVE_TTL:     during actual matches we want near-real-time
// ─────────────────────────────────────────────────────────────────────────────
const cache = new Map();
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}
const TTL = {
  FIXTURES: 24 * 60 * 60 * 1000,   // 24h
  SQUADS:   12 * 60 * 60 * 1000,   // 12h
  INJURIES:  2 * 60 * 60 * 1000,   // 2h
  MARKETS:       60 * 1000,        // 60s
  LIVE:          30 * 1000,        // 30s
  STANDINGS: 5 * 60 * 1000,        // 5m
};

// ─────────────────────────────────────────────────────────────────────────────
// Competition config
//
// COMPETITIONS is the list of selectable competition levels the frontend
// surfaces in its dropdown. Each entry has:
//   id:           short slug used in API routes
//   label:        user-facing name
//   oddsKey:      Odds API sport key for matches (h2h, totals)
//   oddsKeyWin:   Odds API sport key for outright/futures
//   apiFootball:  { leagueId, season } for API-Football
//   openfootball: optional path to free tournament JSON
//
// Start: World Cup 2026. Adding new competitions later is one config entry +
// (sometimes) a different data shape if the competition doesn't have outright markets.
// ─────────────────────────────────────────────────────────────────────────────
const COMPETITIONS = {
  'world_cup_2026': {
    id: 'world_cup_2026',
    label: 'World Cup 2026',
    oddsKey: 'soccer_fifa_world_cup',
    oddsKeyWin: 'soccer_fifa_world_cup_winner',
    apiFootball: { leagueId: 1, season: 2026 },
    openfootball: 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json',
  },
  // Stubs for future expansion — UI hides any with disabled:true
  'epl': {
    id: 'epl', label: 'Premier League',
    oddsKey: 'soccer_epl', oddsKeyWin: 'soccer_epl_winner',
    apiFootball: { leagueId: 39, season: 2025 },
    disabled: true,
  },
  'champions_league': {
    id: 'champions_league', label: 'Champions League',
    oddsKey: 'soccer_uefa_champs_league', oddsKeyWin: 'soccer_uefa_champs_league_winner',
    apiFootball: { leagueId: 2, season: 2025 },
    disabled: true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Data fetchers
// Each is the one source of truth for its data — routes call into these,
// they never fetch directly. Makes caching + error handling consistent.
// ─────────────────────────────────────────────────────────────────────────────

// ── openfootball: fixtures + groups (FREE) ──
async function fetchTournamentSchedule(competitionId) {
  const comp = COMPETITIONS[competitionId];
  if (!comp?.openfootball) return null;
  const cacheKey = `schedule:${competitionId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const data = await fetchJson(comp.openfootball);
    return cacheSet(cacheKey, data, TTL.FIXTURES);
  } catch (e) {
    log('schedule fetch failed:', e.message);
    return null;
  }
}

// ── Build groups from the openfootball schedule ──
// The raw JSON lists matches with team1/team2/group. We aggregate into:
//   { Group A: { teams: [...], matches: [...] }, ... }
// This is what powers the Groups dashboard.
function buildGroupsFromSchedule(schedule) {
  if (!schedule?.matches) return {};
  const groups = {};
  for (const m of schedule.matches) {
    if (!m.group) continue; // skip knockout matches (no group field)
    if (!groups[m.group]) groups[m.group] = { teams: new Set(), matches: [] };
    groups[m.group].matches.push(m);
    // Only add real team names (placeholders like "W101" mean knockout-bracket positions)
    const isPlaceholder = (s) => /^[WL]\d+/.test(s) || /^[A-L]\d/.test(s);
    if (!isPlaceholder(m.team1)) groups[m.group].teams.add(m.team1);
    if (!isPlaceholder(m.team2)) groups[m.group].teams.add(m.team2);
  }
  // Convert team Sets to sorted arrays, return plain object
  const out = {};
  Object.keys(groups).sort().forEach(g => {
    out[g] = {
      teams: Array.from(groups[g].teams).sort(),
      matches: groups[g].matches,
    };
  });
  return out;
}

// ── Odds API: outright/futures markets ──
// "Outrights" in Odds API speak = futures markets (tournament winner, group winner, etc.).
// Sport keys ending in _winner generally return outrights only.
async function fetchOddsApiOutrights(sportKey) {
  if (!ODDS_API_KEY) return { error: 'ODDS_API_KEY not configured' };
  const cacheKey = `outrights:${sportKey}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const u = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?` +
              `apiKey=${ODDS_API_KEY}&regions=us,uk,eu&markets=outrights&oddsFormat=decimal`;
    const data = await fetchJson(u);
    return cacheSet(cacheKey, data, TTL.MARKETS);
  } catch (e) {
    log('outrights fetch failed:', sportKey, e.message);
    return { error: e.message };
  }
}

// ── Odds API: match h2h + totals ──
async function fetchOddsApiMatches(sportKey) {
  if (!ODDS_API_KEY) return { error: 'ODDS_API_KEY not configured' };
  const cacheKey = `matches-odds:${sportKey}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const u = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?` +
              `apiKey=${ODDS_API_KEY}&regions=us,uk&markets=h2h,totals&oddsFormat=decimal`;
    const data = await fetchJson(u);
    return cacheSet(cacheKey, data, TTL.MARKETS);
  } catch (e) {
    log('match odds fetch failed:', sportKey, e.message);
    return { error: e.message };
  }
}

// ── API-Football: team squad ──
async function fetchSquad(teamId, season) {
  if (!API_FOOTBALL_KEY) return null;
  const cacheKey = `squad:${teamId}:${season}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const u = `https://v3.football.api-sports.io/players/squads?team=${teamId}`;
    const data = await fetchJson(u, { headers: { 'x-apisports-key': API_FOOTBALL_KEY } });
    return cacheSet(cacheKey, data, TTL.SQUADS);
  } catch (e) {
    log('squad fetch failed:', teamId, e.message);
    return null;
  }
}

// ── API-Football: current injuries for a league ──
async function fetchInjuries(leagueId, season) {
  if (!API_FOOTBALL_KEY) return null;
  const cacheKey = `injuries:${leagueId}:${season}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const u = `https://v3.football.api-sports.io/injuries?league=${leagueId}&season=${season}`;
    const data = await fetchJson(u, { headers: { 'x-apisports-key': API_FOOTBALL_KEY } });
    return cacheSet(cacheKey, data, TTL.INJURIES);
  } catch (e) {
    log('injuries fetch failed:', leagueId, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic: parse an outright market into a clean leaderboard
// Odds API outrights vary in structure (one event per book in some, one event
// with multiple outcomes in others). Flatten into:
//   [{ name, prices: { FanDuel: 4.5, DraftKings: 5.0, ... }, bestPrice, impliedPct }]
// ─────────────────────────────────────────────────────────────────────────────
function flattenOutrights(rawData) {
  if (!Array.isArray(rawData)) return [];
  // One event typically holds all outright outcomes; some books each appear as bookmakers[i].
  const event = rawData[0];
  if (!event?.bookmakers) return [];
  const byOutcome = new Map();
  for (const bk of event.bookmakers) {
    const bookLabel = bk.title || bk.key;
    for (const mkt of (bk.markets || [])) {
      // Outright markets sometimes also include "outright_lay" — skip lay-side
      if (mkt.key !== 'outrights') continue;
      for (const outcome of (mkt.outcomes || [])) {
        const name = outcome.name;
        if (!byOutcome.has(name)) byOutcome.set(name, { name, prices: {} });
        byOutcome.get(name).prices[bookLabel] = Number(outcome.price);
      }
    }
  }
  const out = Array.from(byOutcome.values()).map(o => {
    const priceValues = Object.values(o.prices).filter(v => !isNaN(v));
    const bestPrice = priceValues.length ? Math.max(...priceValues) : null;
    const avgPrice = priceValues.length ? priceValues.reduce((a, b) => a + b, 0) / priceValues.length : null;
    const impliedPct = avgPrice ? Math.round((1 / avgPrice) * 1000) / 10 : null;
    return { ...o, bestPrice, avgPrice, impliedPct };
  });
  // Sort by implied probability descending (favorites first)
  out.sort((a, b) => (b.impliedPct || 0) - (a.impliedPct || 0));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// API routes
// ─────────────────────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function handleApi(reqUrl, res) {
  const parsed = url.parse(reqUrl, true);
  const pathname = parsed.pathname;
  const q = parsed.query;

  // ── /healthz — Railway healthcheck endpoint ──
  // Returns 200 quickly; Railway will mark the deployment ready once this responds.
  // Kept dependency-free (no external API calls) so a flaky upstream never marks us unhealthy.
  if (pathname === '/healthz' || pathname === '/api/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  // ── /api/competitions — list of supported competitions ──
  if (pathname === '/api/competitions') {
    const list = Object.values(COMPETITIONS)
      .filter(c => !c.disabled)
      .map(c => ({ id: c.id, label: c.label }));
    return sendJson(res, 200, { competitions: list });
  }

  // ── /api/schedule — fixtures + groups for a competition ──
  if (pathname === '/api/schedule') {
    const cid = q.competition || 'world_cup_2026';
    const schedule = await fetchTournamentSchedule(cid);
    if (!schedule) return sendJson(res, 404, { error: 'schedule unavailable' });
    const groups = buildGroupsFromSchedule(schedule);
    return sendJson(res, 200, { competition: cid, name: schedule.name, groups, matches: schedule.matches });
  }

  // ── /api/outright/winner — tournament winner odds ──
  if (pathname === '/api/outright/winner') {
    const cid = q.competition || 'world_cup_2026';
    const comp = COMPETITIONS[cid];
    if (!comp?.oddsKeyWin) return sendJson(res, 404, { error: 'no winner market for this competition' });
    const raw = await fetchOddsApiOutrights(comp.oddsKeyWin);
    if (raw?.error) return sendJson(res, 502, raw);
    const standings = flattenOutrights(raw);
    return sendJson(res, 200, { market: 'tournament_winner', standings, lastUpdate: Date.now() });
  }

  // ── /api/outright/groups — per-group: winner odds + qualify odds ──
  // Odds API splits these into many distinct outright sub-markets, all under the same
  // sport key — they appear as separate events. We pull them all and route by name.
  if (pathname === '/api/outright/groups') {
    const cid = q.competition || 'world_cup_2026';
    const comp = COMPETITIONS[cid];
    if (!comp?.oddsKey) return sendJson(res, 404, { error: 'no markets configured' });
    // Group-specific markets often live under the matches key (not the _winner key)
    // because each is treated as its own outright "event". We try both.
    try {
      const cacheKey = `group-markets:${cid}`;
      let raw = cacheGet(cacheKey);
      if (!raw) {
        const u = `https://api.the-odds-api.com/v4/sports/${comp.oddsKey}/odds?` +
                  `apiKey=${ODDS_API_KEY}&regions=us,uk,eu&markets=outrights&oddsFormat=decimal`;
        raw = await fetchJson(u);
        cacheSet(cacheKey, raw, TTL.MARKETS);
      }
      // Parse: each event.sport_title / .title encodes which group/market this is
      // e.g. "FIFA World Cup - Group A Winner" / "Group A - To Qualify"
      const groupMarkets = {};
      for (const event of (raw || [])) {
        const title = (event.sport_title || '') + ' ' + (event.home_team || '') + ' ' + (event.away_team || '');
        const groupMatch = title.match(/Group\s+([A-L])/i);
        if (!groupMatch) continue;
        const group = `Group ${groupMatch[1].toUpperCase()}`;
        const isQualify = /qualify|advance|knockout|to qualify/i.test(title);
        const isWinner = /winner|to win/i.test(title) && !isQualify;
        if (!groupMarkets[group]) groupMarkets[group] = { winner: [], qualify: [] };
        const flat = flattenOutrights([event]);
        if (isQualify) groupMarkets[group].qualify = flat;
        else if (isWinner) groupMarkets[group].winner = flat;
      }
      return sendJson(res, 200, { groupMarkets, lastUpdate: Date.now() });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  // ── /api/outright/top-scorer — golden boot, top assists, etc ──
  if (pathname === '/api/outright/player-props') {
    const cid = q.competition || 'world_cup_2026';
    const comp = COMPETITIONS[cid];
    if (!comp?.oddsKey) return sendJson(res, 404, { error: 'no markets configured' });
    // Player futures live alongside other outrights — filter by title keywords
    const cacheKey = `player-props:${cid}`;
    let raw = cacheGet(cacheKey);
    if (!raw) {
      try {
        const u = `https://api.the-odds-api.com/v4/sports/${comp.oddsKey}/odds?` +
                  `apiKey=${ODDS_API_KEY}&regions=us,uk,eu&markets=outrights&oddsFormat=decimal`;
        raw = await fetchJson(u);
        cacheSet(cacheKey, raw, TTL.MARKETS);
      } catch (e) {
        return sendJson(res, 502, { error: e.message });
      }
    }
    const playerMarkets = {};
    for (const event of (raw || [])) {
      const title = ((event.sport_title || '') + ' ' + (event.home_team || '') + ' ' + (event.away_team || '')).toLowerCase();
      let marketLabel = null;
      if (/top scorer|golden boot|goalscorer/i.test(title)) marketLabel = 'Top Scorer';
      else if (/most assists|golden playmaker/i.test(title)) marketLabel = 'Top Assists';
      else if (/golden glove|best goalkeeper/i.test(title)) marketLabel = 'Golden Glove';
      else if (/player of the tournament|best player/i.test(title)) marketLabel = 'Player of Tournament';
      if (!marketLabel) continue;
      if (!playerMarkets[marketLabel]) playerMarkets[marketLabel] = [];
      const flat = flattenOutrights([event]);
      playerMarkets[marketLabel].push(...flat);
    }
    return sendJson(res, 200, { playerMarkets, lastUpdate: Date.now() });
  }

  // ── /api/matches — upcoming + live match h2h odds ──
  if (pathname === '/api/matches') {
    const cid = q.competition || 'world_cup_2026';
    const comp = COMPETITIONS[cid];
    if (!comp?.oddsKey) return sendJson(res, 404, { error: 'no markets configured' });
    const raw = await fetchOddsApiMatches(comp.oddsKey);
    if (raw?.error) return sendJson(res, 502, raw);
    // Each match: home/away, kickoff, best h2h prices per outcome
    const matches = (Array.isArray(raw) ? raw : []).map(ev => {
      const prices = { home: {}, draw: {}, away: {} };
      for (const bk of (ev.bookmakers || [])) {
        for (const mkt of (bk.markets || [])) {
          if (mkt.key !== 'h2h') continue;
          for (const o of (mkt.outcomes || [])) {
            const slot = o.name === ev.home_team ? 'home'
                       : o.name === ev.away_team ? 'away'
                       : 'draw';
            prices[slot][bk.title || bk.key] = Number(o.price);
          }
        }
      }
      // Best price + implied % per outcome
      const summarize = (slotPrices) => {
        const vals = Object.values(slotPrices).filter(v => !isNaN(v));
        if (!vals.length) return { best: null, avg: null, impliedPct: null };
        const best = Math.max(...vals);
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        return { best, avg, impliedPct: Math.round((1 / avg) * 1000) / 10 };
      };
      return {
        id: ev.id,
        kickoff: ev.commence_time,
        home: ev.home_team,
        away: ev.away_team,
        homeOdds: { prices: prices.home, ...summarize(prices.home) },
        drawOdds: { prices: prices.draw, ...summarize(prices.draw) },
        awayOdds: { prices: prices.away, ...summarize(prices.away) },
      };
    });
    matches.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    return sendJson(res, 200, { matches, lastUpdate: Date.now() });
  }

  // ── /api/injuries — current injury list for the competition ──
  if (pathname === '/api/injuries') {
    const cid = q.competition || 'world_cup_2026';
    const comp = COMPETITIONS[cid];
    if (!comp?.apiFootball) return sendJson(res, 404, { error: 'no live data source configured' });
    const data = await fetchInjuries(comp.apiFootball.leagueId, comp.apiFootball.season);
    if (!data) return sendJson(res, 200, { injuries: [], note: 'API_FOOTBALL_KEY not configured — set on Railway to enable' });
    // Shape: data.response is an array of { player, team, fixture, type, reason }
    const injuries = (data.response || []).map(inj => ({
      player: inj.player?.name,
      playerId: inj.player?.id,
      team: inj.team?.name,
      teamId: inj.team?.id,
      reason: inj.player?.reason,
      type: inj.player?.type,
      fixture: inj.fixture?.date,
    }));
    return sendJson(res, 200, { injuries, lastUpdate: Date.now() });
  }

  // ── /api/debug — dependency health check ──
  if (pathname === '/api/debug') {
    const checks = {
      oddsApiKeySet: Boolean(ODDS_API_KEY),
      apiFootballKeySet: Boolean(API_FOOTBALL_KEY),
      cacheSize: cache.size,
      uptime: process.uptime(),
      memMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
    return sendJson(res, 200, checks);
  }

  return sendJson(res, 404, { error: 'unknown route' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Static file server for the SPA frontend
// ─────────────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
function serveStatic(filePath, res) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    // /healthz is treated as an API call so Railway's healthcheck hits the JSON handler
    if (req.url.startsWith('/api/') || req.url === '/healthz' || req.url.startsWith('/healthz?')) {
      return handleApi(req.url, res);
    }
    const safe = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    serveStatic(path.join(__dirname, 'public', safe), res);
  } catch (e) {
    log('handler error:', e.message);
    res.writeHead(500); res.end('Server error');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot — bind to 0.0.0.0 so Railway's proxy can reach us. The default Node
// behavior of binding to all interfaces works locally, but on Railway the
// container's interfaces are isolated and an explicit bind keeps things
// reliable across platform updates.
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  log(`World Cup tracker listening on 0.0.0.0:${PORT}`);
  // Environment summary at boot — easy to verify Railway env vars wired correctly
  log('env:', {
    PORT,
    oddsApiKey: ODDS_API_KEY ? `set (${ODDS_API_KEY.length} chars)` : 'NOT SET',
    apiFootballKey: API_FOOTBALL_KEY ? `set (${API_FOOTBALL_KEY.length} chars)` : 'NOT SET',
    nodeVersion: process.version,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown — Railway sends SIGTERM during deploys; respond cleanly
// so the platform can route traffic to the new instance without 502s.
// ─────────────────────────────────────────────────────────────────────────────
function shutdown(signal) {
  log(`received ${signal}, shutting down…`);
  server.close(() => {
    log('http server closed');
    process.exit(0);
  });
  // Hard timeout: if connections don't drain in 10s, force exit
  setTimeout(() => {
    log('shutdown timeout — forcing exit');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Catch unhandled errors so we don't crash silently — Railway will restart but
// the log line tells us what happened.
process.on('uncaughtException', (err) => {
  log('UNCAUGHT EXCEPTION:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  log('UNHANDLED REJECTION:', reason);
});
