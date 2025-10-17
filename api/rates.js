// pages/api/rates.js
// Clean and simple: parallel fetch with timeouts, in-memory cache, de-dup by name,
// prefer base rate but fall back to APR, and (for now) return ONLY ONE lender row.

let CACHE = { ts: 0, data: null };        // warm instance cache (approx 10 minutes)
const MAX_LENDERS = 1;                    // <-- show only one lender row on the page
const CACHE_WINDOW_MS = 10 * 60 * 1000;   // 10 minutes
const REQ_TIMEOUT_MS = 6000;              // 6s per provider

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600'); // 15m CDN cache

  const now = Date.now();
  if (CACHE.data && (now - CACHE.ts) < CACHE_WINDOW_MS) {
    return res.status(200).json(CACHE.data);
  }

  try {
    // List your providers here. We’ll add more as you send URLs.
    const results = await Promise.allSettled([
      withTimeout(landmarkCU(), REQ_TIMEOUT_MS),
      withTimeout(summitCU(),   REQ_TIMEOUT_MS),
      withTimeout(uwcu(),       REQ_TIMEOUT_MS),
      withTimeout(northShore(), REQ_TIMEOUT_MS),
      withTimeout(associatedBank(), REQ_TIMEOUT_MS),
    ]);

    // Keep only fulfilled, with at least one numeric field
    const list = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .filter(x => x && (x.rate || x.apr));

    // De-dup by normalized name
    const deduped = dedupeByName(list);

    // Sort by our preferred ordering and cap the number of rows
    const sorted = deduped.sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
                          .slice(0, MAX_LENDERS);

    const payload = {
      generatedAt: new Date().toISOString(),
      lenders: sorted.length ? sorted : fallbackSample().slice(0, MAX_LENDERS),
    };

    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  } catch (e) {
    const payload = {
      generatedAt: new Date().toISOString(),
      lenders: fallbackSample().slice(0, MAX_LENDERS),
      error: 'partial',
    };
    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  }
}

/* ---------------- helpers ---------------- */

function dedupeByName(items) {
  const m = new Map();
  for (const it of items) {
    const key = String(it.name || '').trim().toLowerCase();
    if (!key) continue;
    if (!m.has(key)) m.set(key, it);
    else {
      // Prefer the one that actually has a base rate; otherwise keep first
      const cur = m.get(key);
      const better =
        (it.rate && !cur.rate) ? it :
        (it.rate && cur.rate ? (Number(it.rate) <= Number(cur.rate) ? it : cur) : cur);
      m.set(key, better);
    }
  }
  return [...m.values()];
}

async function withTimeout(promise, ms) {
  return await Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 ratesbot' }, ...opts });
  if (!res.ok) throw new Error(`Bad response ${res.status} for ${url}`);
  return res.text();
}

// Prefer base rate; if missing, show APR so the UI still has a number
function parseThirtyYear(html) {
  const clean = html.replace(/\s+/g, ' ');
  const patterns = [
    /30\s*(?:year|yr)[^%]{0,160}?(\d{1,2}\.\d{1,3})\s*%[^%]{0,80}?(?:APR|A\.?P\.?R\.?)\s*(\d{1,2}\.\d{1,3})\s*%/i,
    /30\s*(?:year|yr)[^%]{0,160}?(?:APR|A\.?P\.?R\.?)\s*(\d{1,2}\.\d{1,3})\s*%[^%]{0,80}?(\d{1,2}\.\d{1,3})\s*%/i,
    /30[^<]{0,40}?(?:Year|Yr)[^%]{0,160}?(\d{1,2}\.\d{1,3})\s*%[^%]{0,80}?(?:APR)[^%]{0,40}?(\d{1,2}\.\d{1,3})\s*%/i,
  ];
  for (const re of patterns) {
    const m = clean.match(re);
    if (m) {
      const a = parseFloat(m[1]), b = parseFloat(m[2]);
      const base = isFinite(a) && isFinite(b) ? Math.min(a, b) : undefined;
      const apr  = isFinite(a) && isFinite(b) ? Math.max(a, b) : undefined;
      return { rate: base ? trim(base) : undefined, apr: apr ? trim(apr) : undefined };
    }
  }
  return { rate: undefined, apr: undefined };
}

function trim(n) { return n.toFixed(3).replace(/0{1,2}$/, ''); }

/* ---------------- providers ---------------- */

async function landmarkCU() {
  const url = 'https://landmarkcu.com/mortgage-rates';
  const html = await fetchText(url);
  const { rate, apr } = parseThirtyYear(html);
  return {
    name: 'Landmark Credit Union',
    product: '30 yr fixed',
    rate, apr,
    url, contactUrl: 'https://landmarkcu.com/mortgage',
    updatedAt: new Date().toISOString(),
    order: 1,
  };
}

async function summitCU() {
  const url = 'https://www.summitcreditunion.com/mortgages/mortgage-rates';
  const html = await fetchText(url);
  const { rate, apr } = parseThirtyYear(html);
  return {
    name: 'Summit Credit Union',
    product: '30 yr fixed',
    rate, apr,
    url, contactUrl: 'https://www.summitcreditunion.com/',
    updatedAt: new Date().toISOString(),
    order: 2,
  };
}

async function uwcu() {
  const url = 'https://www.uwcu.org/loans/mortgage/rates/';
  const html = await fetchText(url);
  const { rate, apr } = parseThirtyYear(html);
  return {
    name: 'UW Credit Union',
    product: '30 yr fixed',
    rate, apr,
    url, contactUrl: 'https://www.uwcu.org/',
    updatedAt: new Date().toISOString(),
    order: 3,
  };
}

async function northShore() {
  const url = 'https://www.northshorebank.com/personal/loans/mortgage/mortgage-rates.aspx';
  const html = await fetchText(url);
  const { rate, apr } = parseThirtyYear(html);
  return {
    name: 'North Shore Bank',
    product: '30 yr fixed',
    rate, apr,
    url, contactUrl: 'https://www.northshorebank.com/',
    updatedAt: new Date().toISOString(),
    order: 4,
  };
}

async function associatedBank() {
  const url = 'https://www.associatedbank.com/personal/mortgage/mortgage-rates';
  const html = await fetchText(url);
  const { rate, apr } = parseThirtyYear(html);
  return {
    name: 'Associated Bank',
    product: '30 yr fixed',
    rate, apr,
    url, contactUrl: 'https://www.associatedbank.com/',
    updatedAt: new Date().toISOString(),
    order: 5,
  };
}

/* ---------------- fallback ---------------- */

function fallbackSample() {
  const now = new Date().toISOString();
  return [
    { name: 'Landmark Credit Union', product: '30 yr fixed', rate: '6.875', apr: '6.942', url: 'https://landmarkcu.com/mortgage-rates', contactUrl: 'https://landmarkcu.com/mortgage', updatedAt: now, order: 1 },
    { name: 'Summit Credit Union',   product: '30 yr fixed', rate: '6.990', apr: '7.050', url: 'https://www.summitcreditunion.com/mortgages/mortgage-rates', contactUrl: 'https://www.summitcreditunion.com/', updatedAt: now, order: 2 },
    { name: 'UW Credit Union',       product: '30 yr fixed', rate: '7.125', apr: '7.190', url: 'https://www.uwcu.org/loans/mortgage/rates/', contactUrl: 'https://www.uwcu.org/', updatedAt: now, order: 3 },
  ];
}
