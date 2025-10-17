// api/rates.js
// Serverless endpoint for Vercel that fetches lender rates server-side.
// Caches for 10 minutes. Falls back to sample data if scrapes fail.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  try {
    const results = await Promise.allSettled([
      landmarkCU(),
      summitCU(),
      uwcu(),
      northShore(),
      associatedBank(),
    ]);

    const lenders = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .filter(x => x && (x.rate || x.apr)) // only keep rows with a number
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      lenders: lenders.length ? lenders : fallbackSample()
    });
  } catch (e) {
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      lenders: fallbackSample(),
      error: 'partial'
    });
  }
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 ratesbot' }, ...opts });
  if (!res.ok) throw new Error(`Bad response ${res.status} for ${url}`);
  return res.text();
}

// Parse a 30-year fixed row. We try multiple formats and pick the smaller as base rate and larger as APR.
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
      const rate = Math.min(a, b), apr = Math.max(a, b);
      return {
        rate: trimNum(rate),
        apr: trimNum(apr)
      };
    }
  }
  return { rate: undefined, apr: undefined };
}

function trimNum(n) {
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
  return { name: 'North Shore Bank', product: '30 yr fixed', rate, apr, url, contactUrl: 'https://www.northshorebank.com/', updatedAt: new Date
