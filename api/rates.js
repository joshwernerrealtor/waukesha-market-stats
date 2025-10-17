// pages/api/rates.js
// Returns up to 2 lenders: Associated Bank + Landmark Credit Union.
// Server-side fetch with strict timeouts, short in-memory cache, de-dup by name,
// and tolerant parsing that prefers the base "Interest Rate" but falls back to APR.

const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes in-memory (per warm function)
const TIMEOUT_MS   = 7000;            // 7 seconds per provider
const MAX_LENDERS  = 2;               // show Associated + Landmark (you can increase later)

let CACHE = { ts: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600"); // 15m edge cache

  const now = Date.now();
  if (CACHE.data && now - CACHE.ts < CACHE_TTL_MS) {
    return res.status(200).json(CACHE.data);
  }

  try {
    const results = await Promise.allSettled([
      withTimeout(fetchAssociatedBank(), TIMEOUT_MS),
      withTimeout(fetchLandmarkCU(),    TIMEOUT_MS),
    ]);

    // keep good ones with at least one numeric field
    const list = results
      .filter(r => r.status === "fulfilled" && r.value)
      .map(r => r.value)
      .filter(x => x && (x.rate || x.apr));

    const lenders = dedupeByName(list)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
      .slice(0, MAX_LENDERS);

    const payload = {
      generatedAt: new Date().toISOString(),
      lenders: lenders.length ? lenders : fallbackSample().slice(0, MAX_LENDERS)
    };

    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  } catch {
    const payload = {
      generatedAt: new Date().toISOString(),
      lenders: fallbackSample().slice(0, MAX_LENDERS),
      error: "partial"
    };
    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  }
}

/* ---------------- Providers ---------------- */

// 1) Associated Bank — your provided page with labeled Interest Rate/APR
async function fetchAssociatedBank() {
  const url = "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24";
  const html = await fetchText(url);

  // Narrow to the “30 Year Fixed” area so we don’t snag jumbo/ARM rows.
  const block = extractThirtyYearBlock(html);

  // Prefer labeled "Interest Rate" and "APR"
  const interest = findPercent(block, /(Interest\s*Rate|Rate)\s*:?\s*(\d{1,2}\.\d{1,3})\s*%/i);
  const apr      = findPercent(block, /\bAPR\b\s*:?\s*(\d{1,2}\.\d{1,3})\s*%/i);

  // If labels weren’t found, try "two percents near each other" fallback
  const duo = (interest == null || apr == null) ? twoPercentsNearby(block) : null;

  // Choose final numbers with sanity checks
  const baseRate = inRange(interest) ? interest : inRange(duo?.base) ? duo.base : undefined;
  const aprRate  = inRange(apr)      ? apr      : inRange(duo?.apr)  ? duo.apr  : undefined;

  const final = normalizeRateApr(baseRate, aprRate);

  return {
    name: "Associated Bank",
    product: "30 yr fixed",
    rate: final.rate,
    apr: final.apr,
    url,
    contactUrl: "https://www.associatedbank.com/personal/loans/home-loans",
    updatedAt: new Date().toISOString(),
    order: 1
  };
}

// 2) Landmark Credit Union — public HTML page
async function fetchLandmarkCU() {
  const url = "https://landmarkcu.com/mortgage-rates";
  const html = await fetchText(url);

  // Try to isolate the 30-year area first; then parse percents
  const block = extractThirtyYearBlock(html);

  // Landmark sometimes presents “Rate … APR …” in the same vicinity
  const interest = findPercent(block, /(Interest\s*Rate|Rate)\s*:?\s*(\d{1,2}\.\d{1,3})\s*%/i);
  const apr      = findPercent(block, /\bAPR\b\s*:?\s*(\d{1,2}\.\d{1,3})\s*%/i);
  const duo      = (interest == null || apr == null) ? twoPercentsNearby(block) : null;

  const baseRate = inRange(interest) ? interest : inRange(duo?.base) ? duo.base : undefined;
  const aprRate  = inRange(apr)      ? apr      : inRange(duo?.apr)  ? duo.apr  : undefined;

  const final = normalizeRateApr(baseRate, aprRate);

  return {
    name: "Landmark Credit Union",
    product: "30 yr fixed",
    rate: final.rate,
    apr: final.apr,
    url,
    contactUrl: "https://landmarkcu.com/mortgage",
    updatedAt: new Date().toISOString(),
    order: 2
  };
}

/* ---------------- Parsing helpers ---------------- */

function extractThirtyYearBlock(html) {
  const clean = html.replace(/\s+/g, " ");
  const m = clean.match(/30\s*(?:year|yr)\s*(?:fixed)?[^]{0,1800}/i); // take a reasonable window
  return m ? m[0] : clean.slice(0, 2000);
}

function findPercent(txt, re) {
  const m = txt.match(re);
  if (!m) return null;
  const n = parseFloat(m[2] ?? m[1]);
  return Number.isFinite(n) ? trim(n) : null;
}

function twoPercentsNearby(txt) {
  const m =
    txt.match(/(\d{1,2}\.\d{1,3})\s*%[^%]{0,140}?(?:APR|A\.?P\.?R\.?)\s*(\d{1,2}\.\d{1,3})\s*%/i) ||
    txt.match(/(?:APR|A\.?P\.?R\.?)\s*(\d{1,2}\.\d{1,3})\s*%[^%]{0,140}?(\d{1,2}\.\d{1,3})\s*%/i);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const base = Math.min(a, b);
  const apr  = Math.max(a, b);
  return { base: trim(base), apr: trim(apr) };
}

function normalizeRateApr(rate, apr) {
  // If only one number is present, use it as the main rate.
  if (rate != null && apr == null) return { rate, apr: undefined };
  if (rate == null && apr != null) return { rate: apr, apr }; // show APR as the big number

  if (rate != null && apr != null) {
    // APR should not be lower than base rate; if it is, swap them.
    if (parseFloat(apr) < parseFloat(rate)) return { rate: apr, apr: rate };
    return { rate, apr };
  }
  return { rate: undefined, apr: undefined };
}

function inRange(n) {
  const x = parseFloat(n);
  return Number.isFinite(x) && x >= 2 && x <= 20; // keep to plausible mortgage range
}

function trim(n) {
  return n.toFixed(3).replace(/0{1,2}$/, "");
}

/* ---------------- Infra helpers ---------------- */

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 ratesbot" }, ...opts });
  if (!res.ok) throw new Error(`Bad response ${res.status} for ${url}`);
  return res.text();
}

async function withTimeout(promise, ms) {
  return await Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

// Deduplicate by lender name; prefer entries that have a base rate
function dedupeByName(items) {
  const m = new Map();
  for (const it of items) {
    const key = String(it.name || "").trim().toLowerCase();
    if (!key) continue;
    if (!m.has(key)) { m.set(key, it); continue; }
    const cur = m.get(key);
    const better =
      (it.rate && !cur.rate) ? it :
      (it.rate && cur.rate ? (Number(it.rate) <= Number(cur.rate) ? it : cur) : cur);
    m.set(key, better);
  }
  return [...m.values()];
}

/* ---------------- Fallback (shown only if parsing/timing fails) ---------------- */

function fallbackSample() {
  const now = new Date().toISOString();
  return [
    {
      name: "Associated Bank",
      product: "30 yr fixed",
      rate: "6.125",
      apr:  "6.250",
      url: "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24",
      contactUrl: "https://www.associatedbank.com/personal/loans/home-loans",
      updatedAt: now,
      order: 1
    },
    {
      name: "Landmark Credit Union",
      product: "30 yr fixed",
      rate: "6.875",
      apr:  "6.990",
      url: "https://landmarkcu.com/mortgage-rates",
      contactUrl: "https://landmarkcu.com/mortgage",
      updatedAt: now,
      order: 2
    }
  ];
}
