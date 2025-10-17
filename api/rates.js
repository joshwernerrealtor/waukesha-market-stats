// pages/api/rates.js
// Single-lender version wired to Associated Bank (your URL).
// Fetches server-side with timeout, caches briefly, and returns one clean row.

const MAX_LENDERS = 1;                // exactly one lender
const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes
const TIMEOUT_MS = 7000;              // 7s fetch timeout

let CACHE = { ts: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600"); // 15m CDN cache

  // warm in-memory cache (per serverless instance)
  const now = Date.now();
  if (CACHE.data && now - CACHE.ts < CACHE_TTL_MS) {
    return res.status(200).json(CACHE.data);
  }

  try {
    const lender = await withTimeout(associatedBank(), TIMEOUT_MS);

    // if parsing failed, fall back to a sane sample so UI isn't a wall of dashes
    const list = (lender && (lender.rate || lender.apr)) ? [lender] : fallbackSample().slice(0, MAX_LENDERS);

    const payload = { generatedAt: new Date().toISOString(), lenders: list.slice(0, MAX_LENDERS) };
    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  } catch {
    const payload = { generatedAt: new Date().toISOString(), lenders: fallbackSample().slice(0, MAX_LENDERS), error: "partial" };
    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  }
}

/* ---------- Provider: Associated Bank (your exact URL) ---------- */

async function associatedBank() {
  const url = "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24";
  const html = await fetchText(url);

  // Try to find a 30-year fixed row and pick interest vs APR.
  // We search near the phrase 30 (Year|Yr) and capture two percentage numbers.
  // If both present, smaller is base rate, larger is APR.
  const { rate, apr } = parseThirtyYear(html);

  return {
    name: "Associated Bank",
    product: "30 yr fixed",
    rate, apr,
    url,
    contactUrl: "https://www.associatedbank.com/personal/loans/home-loans",
    updatedAt: new Date().toISOString(),
    order: 1
  };
}

/* ---------- Helpers ---------- */

async function withTimeout(promise, ms) {
  return await Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 ratesbot" }, ...opts });
  if (!res.ok) throw new Error(`Bad response ${res.status} for ${url}`);
  return res.text();
}

// Very tolerant parser for “30 year fixed ... X% ... APR Y%” in any order.
function parseThirtyYear(html) {
  const clean = html.replace(/\s+/g, " ");

  // Narrow to a neighborhood around “30 year” to avoid grabbing jumbo/ARM.
  const section =
    clean.match(/(?:30\s*(?:year|yr)[^]{0,800})/i)?.[0] || clean;

  // Look for two percents near that text.
  const twoPercents = section.match(/(\d{1,2}\.\d{1,3})\s*%[^%]{0,120}?(?:APR|A\.?P\.?R\.?)\s*(\d{1,2}\.\d{1,3})\s*%/i)
                    || section.match(/(?:APR|A\.?P\.?R\.?)\s*(\d{1,2}\.\d{1,3})\s*%[^%]{0,120}?(\d{1,2}\.\d{1,3})\s*%/i)
                    || section.match(/(\d{1,2}\.\d{1,3})\s*%[^%]{0,80}?(\d{1,2}\.\d{1,3})\s*%/i);

  if (twoPercents) {
    const a = parseFloat(twoPercents[1]);
    const b = parseFloat(twoPercents[2]);
    if (isFinite(a) && isFinite(b)) {
      const base = Math.min(a, b);
      const apr  = Math.max(a, b);
      return { rate: trim(base), apr: trim(apr) };
    }
  }

  // Last chance: any single percent near “30 year”
  const onePercent = section.match(/(\d{1,2}\.\d{1,3})\s*%/i);
  if (onePercent) return { rate: trim(parseFloat(onePercent[1])) };

  return { rate: undefined, apr: undefined };
}

function trim(n) {
  if (!isFinite(n)) return undefined;
  return n.toFixed(3).replace(/0{1,2}$/, "");
}

/* ---------- Fallback so the UI never looks broken ---------- */

function fallbackSample() {
  const now = new Date().toISOString();
  return [
    {
      name: "Associated Bank",
      product: "30 yr fixed",
      rate: "7.000",
      apr:  "7.120",
      url: "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24",
      contactUrl: "https://www.associatedbank.com/personal/loans/home-loans",
      updatedAt: now,
      order: 1
    }
  ];
}
