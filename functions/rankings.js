// functions/rankings.js
// Fetches Ohio D4 rankings from athletic.net for 100m, 200m, 400m, Pole Vault
// Returns top 4 per event for state / regional / district scope

const https = require('https');

const EVENTS = ['100 Meter Dash', '200 Meter Dash', '400 Meter Dash', 'Pole Vault'];

const EVENT_KEYWORDS = {
  '100 Meter Dash': ['100 meter dash', '100m dash', '100 meters', '100-meter', '100m '],
  '200 Meter Dash': ['200 meter dash', '200m dash', '200 meters', '200-meter', '200m '],
  '400 Meter Dash': ['400 meter dash', '400m dash', '400 meters', '400-meter', '400m '],
  'Pole Vault':     ['pole vault', 'polevault', 'pole-vault'],
};

function matchEvent(str) {
  const lower = (str || '').toLowerCase();
  for (const [canonical, keywords] of Object.entries(EVENT_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return canonical;
  }
  return null;
}

// Lower number = better for all events (negate vault height so same sort works)
function markToNum(mark, event) {
  if (!mark) return 999999;
  const s = String(mark).trim().replace(/[hw]/gi, ''); // strip wind/hand-timing flags
  if (event === 'Pole Vault') {
    // "14-06" or "14-06.00" (feet-inches) → negate so best (highest) sorts first
    const fi = s.match(/^(\d+)-(\d+(?:\.\d+)?)/);
    if (fi) return -(parseInt(fi[1], 10) * 12 + parseFloat(fi[2]));
    // "4.42m" or "4.42" metres
    const m = s.match(/^(\d+\.\d+)/);
    if (m) return -parseFloat(m[1]) * 39.3701;
    return 999999;
  }
  // mm:ss.ss or ss.ss
  const ms = s.match(/^(\d+):(\d+\.\d+)/);
  if (ms) return parseInt(ms[1], 10) * 60 + parseFloat(ms[2]);
  const sec = s.match(/^(\d+\.\d+)/);
  if (sec) return parseFloat(sec[1]);
  return 999999;
}

async function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
      }
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        fetchPage(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── JSON parser ────────────────────────────────────────────────────────────────

function pickField(obj, candidates) {
  const keys = Object.keys(obj);
  const lower = keys.map(k => k.toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c);
    if (i !== -1 && obj[keys[i]] != null && obj[keys[i]] !== '') return String(obj[keys[i]]);
    const p = lower.findIndex(k => k.includes(c));
    if (p !== -1 && obj[keys[p]] != null && obj[keys[p]] !== '') return String(obj[keys[p]]);
  }
  return '';
}

function deepScan(node, results, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    node.forEach(n => deepScan(n, results, seen));
    return;
  }

  // Look for an event name field in this object
  let foundEvent = null;
  for (const v of Object.values(node)) {
    if (typeof v === 'string') {
      const e = matchEvent(v);
      if (e) { foundEvent = e; break; }
    }
    // event might be nested one level (e.g. { Event: { Name: "100 Meter Dash" } })
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const vv of Object.values(v)) {
        if (typeof vv === 'string') {
          const e = matchEvent(vv);
          if (e) { foundEvent = e; break; }
        }
      }
    }
    if (foundEvent) break;
  }

  if (foundEvent) {
    // Find an array that looks like athlete results
    for (const v of Object.values(node)) {
      if (!Array.isArray(v) || v.length === 0) continue;
      const sample = v[0];
      if (!sample || typeof sample !== 'object') continue;
      const sKeys = Object.keys(sample).join(' ').toLowerCase();
      if (!sKeys.includes('name') && !sKeys.includes('athlete') && !sKeys.includes('mark') && !sKeys.includes('time') && !sKeys.includes('result')) continue;

      if (!results[foundEvent]) results[foundEvent] = [];
      for (const r of v) {
        if (!r || typeof r !== 'object') continue;
        const name  = pickField(r, ['athletename','athletefullname','fullname','name','firstname']);
        const school= pickField(r, ['schoolname','teamname','schoolshortname','school','team']);
        const mark  = pickField(r, ['mark','result','performance','time','distance','height','value']);
        const place = pickField(r, ['place','rank','overallplace','position']);
        if (name || mark) {
          results[foundEvent].push({
            place: parseInt(place, 10) || results[foundEvent].length + 1,
            name, school, mark,
          });
        }
      }
      if (results[foundEvent].length) break;
    }
  }

  // Recurse regardless
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') deepScan(v, results, seen);
  }
}

// ── HTML table parser (fallback) ───────────────────────────────────────────────

function parseHtmlTables(html) {
  const results = {};
  EVENTS.forEach(e => results[e] = []);

  // Find headings that contain event names
  const headRe = /<h[2-5][^>]*>([\s\S]*?)<\/h[2-5]>/gi;
  let hm;
  const sections = [];
  while ((hm = headRe.exec(html)) !== null) {
    const text = hm[1].replace(/<[^>]+>/g, '').trim();
    const event = matchEvent(text);
    if (event) sections.push({ event, pos: hm.index + hm[0].length });
  }

  sections.forEach(({ event, pos }) => {
    if ((results[event] || []).length >= 4) return;
    if (!results[event]) results[event] = [];
    const chunk = html.slice(pos, pos + 8000);
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(chunk)) !== null) {
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        cells.push(cm[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&#39;/g,"'").trim());
      }
      if (cells.length >= 3 && /^\d+$/.test(cells[0])) {
        results[event].push({
          place: parseInt(cells[0], 10),
          name:   cells[1] || '',
          school: cells[2] || '',
          mark:   cells[3] || cells[4] || '',
        });
        if (results[event].length >= 4) break;
      }
    }
  });

  return results;
}

// ── Main parse ─────────────────────────────────────────────────────────────────

function parseHtml(html) {
  const results = {};
  EVENTS.forEach(e => results[e] = []);

  // Try __NEXT_DATA__
  const ndMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (ndMatch) {
    try {
      const nd = JSON.parse(ndMatch[1]);
      deepScan(nd, results);
    } catch(e) {}
  }

  // Try other inline JSON blobs in script tags (athletic.net sometimes uses window.INITIAL_STATE etc.)
  if (!Object.values(results).some(v => v.length > 0)) {
    const scriptRe = /<script[^>]*>([\s\S]{200,}?)<\/script>/gi;
    let sm;
    while ((sm = scriptRe.exec(html)) !== null) {
      const content = sm[1];
      if (!content.includes('100') && !content.includes('vault')) continue;
      // Try to parse top-level JSON object or array
      const jsonRe = /(?:window\.\w+\s*=\s*)?(\{[\s\S]{100,}\}|\[[\s\S]{100,}\])(?:\s*;|\s*$)/g;
      let jm;
      while ((jm = jsonRe.exec(content)) !== null) {
        try {
          const parsed = JSON.parse(jm[1]);
          deepScan(parsed, results);
          if (Object.values(results).some(v => v.length > 0)) break;
        } catch(e) {}
      }
    }
  }

  // HTML table fallback
  if (!Object.values(results).some(v => v.length > 0)) {
    const tableResults = parseHtmlTables(html);
    Object.assign(results, tableResults);
  }

  return results;
}

// ── Merge two result sets (for regional = district1 + district2) ───────────────

function merge(r1, r2) {
  const out = {};
  EVENTS.forEach(e => {
    const combined = [...(r1[e] || []), ...(r2[e] || [])];
    const seen = new Set();
    const unique = combined.filter(r => {
      const key = (r.name || '').toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    unique.sort((a, b) => markToNum(a.mark, e) - markToNum(b.mark, e));
    out[e] = unique.slice(0, 4).map((r, i) => ({ ...r, place: i + 1 }));
  });
  return out;
}

// ── Handler ────────────────────────────────────────────────────────────────────

const SOURCES = {
  state:     'https://www.athletic.net/track-and-field-outdoor/usa/high-school/ohio/division4',
  district:  'https://www.athletic.net/TrackAndField/rankings/list/178541/m',
  regional1: 'https://www.athletic.net/TrackAndField/rankings/list/178541/m',
  regional2: 'https://www.athletic.net/TrackAndField/rankings/list/178540/m',
};

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, s-maxage=1800, max-age=900',
  };

  const type = (event.queryStringParameters || {}).type || 'state';

  try {
    let results;

    if (type === 'district') {
      const html = await fetchPage(SOURCES.district);
      results = parseHtml(html);
      EVENTS.forEach(e => { results[e] = (results[e] || []).slice(0, 4); });
    } else if (type === 'regional') {
      const [h1, h2] = await Promise.all([fetchPage(SOURCES.regional1), fetchPage(SOURCES.regional2)]);
      results = merge(parseHtml(h1), parseHtml(h2));
    } else {
      const html = await fetchPage(SOURCES.state);
      results = parseHtml(html);
      EVENTS.forEach(e => { results[e] = (results[e] || []).slice(0, 4); });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ type, results, fetched: new Date().toISOString() }),
    };
  } catch (err) {
    return {
      statusCode: 200, // soft-fail so frontend can show graceful message
      headers,
      body: JSON.stringify({ type, results: {}, error: err.message, fetched: new Date().toISOString() }),
    };
  }
};
