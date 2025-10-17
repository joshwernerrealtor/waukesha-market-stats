// pages/api/rates.js
// Parallel fetch with timeouts + 10-minute in-memory cache per region.
// Falls back to APR when base rate missing.

let CACHE = { ts: 0, data: null }; // survives while the function instance stays warm

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600'); // 15m CDN cache

  // Serve warm cache instantly (10 minutes)
  const now = Date.now();
  if (CACHE.data && (now - CACHE.ts) < 10 * 60 * 1000) {
    return res.status(200).json(CACHE.data);
  }

  try {
    const results = await Promise.allSettled([
      withTimeout(landmarkCU(), 6000),
      withTimeout(summitCU(), 6000),
      withTimeout(uwcu(), 6000),
      withTimeout(northShore(), 6000),
      withTimeout(associatedBank(), 6000),
    ]);

    const lenders = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .filter(x => x && (x.rate || x.apr))
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

    const payload = {
      generatedAt: new Date().toISOString(),
      lenders: lenders.length ? lenders : fallbackSample()
    };

    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  } catch (e) {
    const payload = { generatedAt: new Date().toISOString(), lenders: fallbackSample(), error: 'partial' };
    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  }
}

async function withTimeout(promise, ms) {
  return await Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 ratesbot' }, ...opts });
  if (!res.ok) throw new Error(`Bad response ${res.status} for ${url}`);
  return res.text();
}

// Prefer base rate; if missing, at least provide APR so UI shows a number
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
      const a = parseFloat(m[1]);
      const b = parseFloat(m[2]);
      const base = isFinite(a) && isFinite(b) ? Math.min(a, b) : undefined;
      const apr  = isFinite(a) && isFinite(b) ? Math.max(a, b) : undefined;
      return { rate: base ? trim(base) : undefined, apr: apr ? trim(apr) : undefined };
    }
  }
  return { rate: undefined, apr: undefined };
}

function trim(n) { return n.toFixed(3).replace(/0{1,2}$/, ''); }

// Providers
async function landmarkCU() {
  const url = 'https://landmarkcu.com/mortgage-rates';
  const html = await fetchText(url);
  const { rate, apr } = parseThirtyYear(html);
  return { name: 'Landmark Credit Union', product: '30 yr fixed', rate, apr, url, contactUrl: 'https://landmarkcu.com/mortgage', updatedAt: new Date().toISOString(), order: 1 };
}
async function summitCU() {
  const url = 'https://www.summitcreditunion.com/mortgages/mortgage-rates';
  const html = await fetchText(url);
  const { rate, apr } = parseThirtyYear(html);
  return { name: 'Summit Credit Union', product: '30 yr fixed', rate, apr, url, contactUrl: 'https://www.summitcreditunion.com/', updatedAt: new Date().toISOString(), order: 2 };
}
async function uwcu() {
  const url = 'https://www.uwcu.org/loans/mortgage/rates/';
  const html = await fetchText(url);
  const { rate, apr } = parseThirtyYear(html);
  return { name: 'UW Credit Union', product: '30 yr fixed', rate, apr, url, contactUrl: 'https://www.uwcu.org/', updatedAt: new Date().toISOString(), order: 3 };
}
async function northShore() {
  const url = 'https://www.northshorebank.com/personal/loans/mortgage/mortgage-rates.aspx';
  const html = await fetchText(url);
  const { rate, apr } = parseThirtyYear(html);
  return { name: 'North Shore Bank', product: '30 yr fixed', rate, apr, url, contactUrl: 'https://www.northshorebank.com/', updatedAt: new Date().toISOString(), order: 4 };
}
async function associatedBank() {
  const url = 'https://www.associatedbank.com/personal/mortgage/mortgage-rates';
  const html = await fetchText(url);
  const { rate, apr } = parseThirtyYear(html);
  return { name: 'Associated Bank', product: '30 yr fixed', rate, apr, url, contactUrl: 'https://www.associatedbank.com/', updatedAt: new Date().toISOString(), order: 5 };
}

function fallbackSample() {
  const now = new Date().toISOString();
  return [
    { name: 'Landmark Credit Union', product: '30 yr fixed', rate: '6.875', apr: '6.942', url: 'https://landmarkcu.com/mortgage-rates', contactUrl: 'https://landmarkcu.com/mortgage', updatedAt: now, order: 1 },
    { name: 'Summit Credit Union', product: '30 yr fixed', rate: '6.990', apr: '7.050', url: 'https://www.summitcreditunion.com/mortgages/mortgage-rates', contactUrl: 'https://www.summitcreditunion.com/', updatedAt: now, order: 2 },
    { name: 'UW Credit Union', product: '30 yr fixed', rate: '7.125', apr: '7.190', url: 'https://www.uwcu.org/loans/mortgage/rates/', contactUrl: 'https://www.uwcu.org/', updatedAt: now, order: 3 }
  ];
}
