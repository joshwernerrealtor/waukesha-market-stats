// api/rates.js
// Fetches & parses public rate tables for 3 lenders, returns a compact JSON payload.

export const config = { runtime: "nodejs" };

const LENDERS = [
  {
    name: "Landmark Credit Union",
    url: "https://landmarkcu.com/mortgage-rates",
    terms: [
      { key: "30-year fixed",  labels: [/30[-\s]?year/i, /30 yr/i], type: "fixed" },
      { key: "15-year fixed",  labels: [/15[-\s]?year/i, /15 yr/i], type: "fixed" },
      { key: "5/6 ARM",        labels: [/5\/6\s*arm/i, /5-6\s*arm/i], type: "arm" }
    ]
  },
  {
    name: "UW Credit Union",
    url: "https://www.uwcu.org/borrow/home-loans/mortgages/purchase-rates/",
    terms: [
      { key: "30-year fixed", labels: [/30[-\s]?year/i], type: "fixed" },
      { key: "15-year fixed", labels: [/15[-\s]?year/i], type: "fixed" },
      { key: "7/6 ARM",       labels: [/7\/6\s*arm/i],    type: "arm" }
    ]
  },
  {
    name: "Community State Bank",
    url: "https://csb.bank/mortgage-rates",
    terms: [
      { key: "30-year fixed", labels: [/30[-\s]?year/i], type: "fixed" },
      { key: "15-year fixed", labels: [/15[-\s]?year/i], type: "fixed" }
    ]
  }
];

// --- helpers ---------------------------------------------------------------

function toNum(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeHtml(html) {
  // Keep enough whitespace to separate cells, but collapse runs
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(th|td|p|div|span|li|strong|em|b|h\d)>/gi, "$& ") // add a space after block-ish closers
    .replace(/\s+/g, " ")
    .trim();
}

// Find numbers near a label like "30 Year Fixed", then pull Rate/APR/Points
function extractProduct(text, labelRegex) {
  const label = labelRegex;
  const m = label.exec(text);
  if (!m) return null;

  // Look in a window after the label for rate-like things
  const start = Math.max(0, m.index);
  const window = text.slice(start, start + 550); // small window after match

  // Prefer named fields if present
  const rate  = window.match(/(?:^|[\s>])(?:rate|interest)\s*[:=]?\s*([0-9.]{2,5})\s*%/i)?.[1]
             || window.match(/([0-9]\d?(?:\.\d{1,3})?)\s*%\s*(?:rate|interest)/i)?.[1]
             || window.match(/([0-9]\d?(?:\.\d{1,3})?)\s*%/i)?.[1];

  const apr   = window.match(/\bapr\b\s*[:=]?\s*([0-9.]{2,5})\s*%/i)?.[1]
             || window.match(/([0-9]\d?(?:\.\d{1,3})?)\s*%\s*apr/i)?.[1];

  const points = window.match(/\bpoints?\b\s*[:=]?\s*([0-9.]{1,3})/i)?.[1]
              || window.match(/([0-9.]{1,3})\s*points?/i)?.[1];

  // If we found at least a rate or APR, return it
  if (rate || apr) {
    return {
      rate:  toNum(rate),
      apr:   toNum(apr),
      points: toNum(points)
    };
  }
  return null;
}

async function fetchRatesFor(lender) {
  try {
    const resp = await fetch(lender.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RateBot/1.0)",
        "Accept": "text/html,*/*;q=0.8"
      },
      redirect: "follow"
    });
    if (!resp.ok) throw new Error(`Upstream ${resp.status}`);
    const raw = await resp.text();
    const html = normalizeHtml(raw);

    const products = [];

    for (const term of lender.terms) {
      let found = null;
      for (const label of term.labels) {
        const out = extractProduct(html, new RegExp(label, "i"));
        if (out) { found = out; break; }
      }
      if (found) {
        products.push({
          term: term.key,
          ...found
        });
      }
    }

    return {
      name: lender.name,
      url: lender.url,
      products
    };
  } catch (e) {
    return {
      name: lender.name,
      url: lender.url,
      error: String(e?.message || e),
      products: []
    };
  }
}

// --- handler ---------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const results = await Promise.all(LENDERS.map(fetchRatesFor));

  // Light caching: 3 hours at the edge, allow stale while revalidate
  res.setHeader("Cache-Control", "s-maxage=10800, stale-while-revalidate=1800");

  res.status(200).json({
    updatedAt: new Date().toISOString(),
    lenders: results
  });
}
