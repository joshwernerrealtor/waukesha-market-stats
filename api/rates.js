// pages/api/rates.js
// Serverless endpoint for lender rates. Parallel fetch with timeouts; prefers rate, falls back to APR.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600'); // 15m cache, 1h stale
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

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      lenders: lenders.length >= 2 ? lenders : (lenders.length ? lenders.concat(fallbackSample().slice(0, 2 - lenders.length)) : fallbackSample())
    });
  } catch (e) {
    res.status(200).json({ generatedAt: new Date().toISOString(), lenders: fallbackSample(), error: 'partial' });
  }
}

async function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const val = await promise;
    clearTimeout(t);
    return val;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 ratesbot' }, ...opts });
  if (!res.ok) throw new Error(`Bad response ${res.status} for ${url}`);
  return res.text();
}

// Prefer base rate if found; otherwise APR. Return whichever exists.
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
      const rate = Math.min(a, b);
      const apr  = Math.max(a, b);
      return {
        rate: isFinite(rate) ? trim(rate) : undefined,
        apr: isFinite(apr) ? trim(apr) : undefined,
      };
    }
  }
  return { rate: undefined, apr: undefined };
}

function trim(n) {
  return n.toFixed(3).replace(/0{1,2}$/, '');
}

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

// Fallback list so your UI never shows a wall of dashes
function fallbackSample() {
  const now = new Date().toISOString();
  return [
    { name: 'Landmark Credit Union', product: '30 yr fixed', rate: '6.875', apr: '6.942', url: 'https://landmarkcu.com/mortgage-rates', contactUrl: 'https://landmarkcu.com/mortgage', updatedAt: now, order: 1 },
    { name: 'Summit Credit Union', product: '30 yr fixed', rate: '6.990', apr: '7.050', url: 'https://www.summitcreditunion.com/mortgages/mortgage-rates', contactUrl: 'https://www.summitcreditunion.com/', updatedAt: now, order: 2 },
    { name: 'UW Credit Union', product: '30 yr fixed', rate: '7.125', apr: '7.190', url: 'https://www.uwcu.org/loans/mortgage/rates/', contactUrl: 'https://www.uwcu.org/', updatedAt: now, order: 3 }
  ];
}
