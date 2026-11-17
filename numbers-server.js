'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.NUMBERS_PORT || 8101);
const HOST = process.env.NUMBERS_HOST || '127.0.0.1';
const APP_PATH = path.join(__dirname, 'alfa-touch-numbers.html');
const STATE_PATH = path.join(process.env.NUMBERS_DATA_DIR || __dirname, 'numbers-state.json');
const PUBLIC_REFRESH_TTL = process.env.NUMBERS_PUBLIC === '1' ? 10000 : 0;
const UPSTREAM_TTL = 45 * 1000; // refetch upstream at most every 45s
const MAX_ADDITIONS = 800;

// ---------------- state (tracks numbers seen since first run) ----------------
let state = {
  created: new Date().toISOString(),
  seen: { alfa: [], touch: [] },
  additions: [] // { t, src, n }
};

try {
  if (fs.existsSync(STATE_PATH)) {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    state = {
      created: raw.created || state.created,
      checkedAt: raw.checkedAt,
      lastSnapshot: raw.lastSnapshot,
      seen: { alfa: raw.seen?.alfa || [], touch: raw.seen?.touch || [] },
      additions: Array.isArray(raw.additions) ? raw.additions : []
    };
  }
} catch (e) {
  console.error('[state] could not load:', e.message);
}

let seenSets = {
  alfa: new Set(state.seen.alfa),
  touch: new Set(state.seen.touch)
};

const lastSnapshot = {
  alfa: Array.isArray(state.lastSnapshot?.alfa) ? new Set(state.lastSnapshot.alfa) : null,
  touch: Array.isArray(state.lastSnapshot?.touch) ? new Set(state.lastSnapshot.touch) : null
};
const checkedAt = { alfa: state.checkedAt?.alfa ?? null, touch: state.checkedAt?.touch ?? null };
for (const source of ['alfa', 'touch']) {
  for (const number of lastSnapshot[source] || []) seenSets[source].add(number);
}

function saveState() {
  const out = {
    created: state.created,
    checkedAt,
    lastSnapshot: {
      alfa: lastSnapshot.alfa ? [...lastSnapshot.alfa] : null,
      touch: lastSnapshot.touch ? [...lastSnapshot.touch] : null
    },
    seen: { alfa: [...seenSets.alfa], touch: [...seenSets.touch] },
    additions: state.additions.slice(-MAX_ADDITIONS)
  };
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(out));
  } catch (e) {
    console.error('[state] save failed:', e.message);
  }
}

function track(source, numbers, nowIso) {
  const seen = seenSets[source];
  const prev = lastSnapshot[source];
  const list = [...new Set(numbers.map(String))];

  // first ever run for this source -> baseline, nothing counts as "new"
  const firstRun = prev === null && seen.size === 0;
  const freshly = firstRun ? [] : list.filter(n => !seen.has(n));

  if (!firstRun && freshly.length) {
    for (const n of freshly) {
      state.additions.push({ t: nowIso, src: source, n });
    }
    state.additions = state.additions.slice(-MAX_ADDITIONS);
    console.log(`[new] ${source}: +${freshly.length} (${freshly.slice(0, 5).join(', ')}${freshly.length > 5 ? '…' : ''})`);
  }

  for (const n of list) seen.add(n);
  lastSnapshot[source] = new Set(list);
  checkedAt[source] = nowIso;

  // used only for the "added in this refresh" flash
  const justAdded = prev ? list.filter(n => !prev.has(n)) : [];
  saveState();
  const current = lastSnapshot[source];
  const justRemoved = prev ? [...prev].filter(number => !current.has(number)) : [];
  return { list, freshly, justAdded, justRemoved };
}

// ---------------- upstream fetchers ----------------
function normalizeNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  const local = digits.startsWith('00961') && digits.length === 13 ? digits.slice(5) :
    digits.startsWith('961') && digits.length === 11 ? digits.slice(3) : digits;
  if (!/^\d{8}$/.test(local)) throw new Error('Unexpected phone number format');
  return local;
}
async function fetchAlfa(tierId) {
  const category = tierId ? 'regular=false&tier_id=' + tierId : 'regular=true';
  const seen = new Set();
  for (let page = 1; ; page++) {
    const url = `https://estore.alfa.com.lb/api/vanity/numbers?${category}&availability_status=available&sort_by=best_match&page=${page}&limit=100`;
    const r = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) throw new Error(`Alfa HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j.data)) throw new Error('Alfa: unexpected payload');
    const previousSize = seen.size;
    for (const x of j.data) seen.add(normalizeNumber(x?.phone_number));
    if (j.data.length < 100) return [...seen];
    if (seen.size === previousSize || page === 100) throw new Error('Pagination did not finish');
  }
}

async function fetchTouch(reservationType = 'regular') {
  const r = await fetch('https://touch.com.lb/api/book-your-number/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ reservation_type: reservationType, gsm_pattern: ['', '', '', '', '', '', '', ''] }),
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error(`Touch HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.numbers)) throw new Error('Touch: unexpected payload');
  return [...new Set(j.numbers.map(number => { const digits = String(number).replace(/\D/g, ''); return normalizeNumber(/^3\d{6}$/.test(digits) ? '0' + digits : number); }))];
}

// ---------------- refresh orchestration ----------------
let cache = { at: 0, payload: null };
let inflight = null;

async function refresh(force) {
  if (cache.payload && Date.now() - cache.at < (force ? PUBLIC_REFRESH_TTL : UPSTREAM_TTL)) return cache.payload;
  if (inflight) return inflight;

  inflight = (async () => {
    const errors = [];
    const nowIso = new Date().toISOString();
    let alfa = [], touch = [];
    let justAlfa = [], justTouch = [];
    const justRemoved = { alfa: null, touch: null };

    const [ar, tr] = await Promise.allSettled([fetchAlfa(), fetchTouch()]);
    if (ar.status === 'fulfilled') {
      const t = track('alfa', ar.value, nowIso);
      alfa = t.list; justAlfa = t.justAdded;
      justRemoved.alfa = t.justRemoved;
    } else {
      errors.push('Alfa: ' + (ar.reason?.message || 'failed'));
      alfa = [...(lastSnapshot.alfa || [])];
    }
    if (tr.status === 'fulfilled') {
      const t = track('touch', tr.value, nowIso);
      touch = t.list; justTouch = t.justAdded;
      justRemoved.touch = t.justRemoved;
    } else {
      errors.push('Touch: ' + (tr.reason?.message || 'failed'));
      touch = [...(lastSnapshot.touch || [])];
    }

    const cutoff = Date.now() - 24 * 3600 * 1000;
    const recent = state.additions.filter(a => new Date(a.t).getTime() >= cutoff);

    const payload = {
      ok: errors.length === 0,
      updatedAt: nowIso,
      checkedAt: { ...checkedAt },
      errors,
      numbers: { alfa, touch },
      counts: { alfa: alfa.length, touch: touch.length },
      justAdded: { alfa: justAlfa, touch: justTouch },
      justRemoved,
      recentAdditions: recent.slice(-60).reverse(),
      totalsNew: {
        alfa: state.additions.filter(a => a.src === 'alfa').length,
        touch: state.additions.filter(a => a.src === 'touch').length
      },
      trackingSince: state.created
    };

    cache = { at: Date.now(), payload };
    return payload;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// Chrome uses its own snapshots and never compares against Regular numbers.
let chromePending;
let chromeCache = { at: 0, payload: null };
let chromeTier;
const chromeLast = { alfa: null, touch: null };
const chromeChecked = { alfa: null, touch: null };
const chromeSeen = { alfa: new Set(), touch: new Set() };
const chromeHistory = [];
const chromeTotals = { alfa: 0, touch: 0 };

async function fetchAlfaChrome() {
  if (!chromeTier) {
    const response = await fetch('https://estore.alfa.com.lb/api/vanity/tiers', { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Alfa tiers HTTP ' + response.status);
    const data = await response.json();
    chromeTier = data.data?.find(tier => tier.name?.toLowerCase() === 'chrome')?.id;
    if (!Number.isInteger(chromeTier)) throw new Error('Chrome tier not found');
  }
  return fetchAlfa(chromeTier);
}

async function refreshChrome() {
  if (chromeCache.payload && Date.now() - chromeCache.at < PUBLIC_REFRESH_TTL) return chromeCache.payload;
  if (chromePending) return chromePending;
  chromePending = (async () => {
    const results = await Promise.allSettled([fetchAlfaChrome(), fetchTouch('Chrome')]);
    const now = new Date().toISOString();
    const errors = [], numbers = {}, justAdded = {}, justRemoved = {};
    for (const [index, source] of ['alfa', 'touch'].entries()) {
      const result = results[index];
      const previous = chromeLast[source];
      justAdded[source] = [];
      justRemoved[source] = null;
      if (result.status === 'fulfilled') {
        const current = new Set(result.value);
        justAdded[source] = previous ? [...current].filter(number => !previous.has(number)) : [];
        justRemoved[source] = previous ? [...previous].filter(number => !current.has(number)) : [];
        for (const number of justAdded[source]) {
          if (chromeSeen[source].has(number)) continue;
          chromeTotals[source]++;
          chromeHistory.push({ t: now, src: source, n: number });
        }
        for (const number of current) chromeSeen[source].add(number);
        chromeLast[source] = current;
        chromeChecked[source] = now;
      } else {
        errors.push((source === 'alfa' ? 'Alfa: ' : 'Touch: ') + result.reason.message);
      }
      numbers[source] = [...(chromeLast[source] || [])];
    }
    const cutoff = Date.now() - 86400000;
    while (chromeHistory.length && Date.parse(chromeHistory[0].t) < cutoff) chromeHistory.shift();
    return { ok: !errors.length, numbers, checkedAt: { ...chromeChecked }, errors, justAdded, justRemoved,
      totalsNew: { ...chromeTotals }, recentAdditions: chromeHistory.slice(-60).reverse() };
  })();
  try {
    const payload = await chromePending;
    chromeCache = { at: Date.now(), payload };
    return payload;
  } finally {
    chromePending = null;
  }
}

// ---------------- http server ----------------
const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname === '/numbers' ? '/' :
    url.pathname.startsWith('/numbers/') ? url.pathname.slice('/numbers'.length) : url.pathname;

  if (route === '/' || route === '/index.html') {
    try {
      const html = fs.readFileSync(APP_PATH, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('alfa-touch-numbers.html not found');
    }
    return;
  }

  if (route === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('alfa-touch-chrome');
    return;
  }

  if (route === '/api/numbers') {
    try {
      const force = url.searchParams.get('force') === '1';
      const category = url.searchParams.get('category') === 'chrome' ? 'chrome' : 'regular';
      const payload = category === 'chrome' ? await refreshChrome() : await refresh(force);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...payload, category }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, errors: [e.message] }));
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Numbers app: http://${HOST}:${PORT}`);
});
