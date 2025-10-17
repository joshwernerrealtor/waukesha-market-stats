// pages/api/rates.js
// Lenders: Associated Bank + Landmark CU + UW Credit Union.
// Tight parsing for 30-year fixed with labeled Rate/APR, strict timeouts,
// short in-memory cache, de-dup by name, and env-var overrides for Landmark.
//
// Env (optional):
//   LCU_RATE=6.625
//   LCU_APR=6.740

const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes
const TIMEOUT_MS   = 7000;            // 7 seconds per provider
const MAX_LENDERS  = 3;

let CACHE = { ts: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  const now = Date.now();
  if (CACHE.data && now - CACHE.ts < CACHE_TTL_MS) {
    return res.status(200).json(CACHE.data);
  }

  try {
    const results = await Promise.allSettled([
      withTimeout(fetchAssociatedBank(), TIMEOUT_MS),
      withTimeout(fetchLandmarkCU(),    TIMEOUT_MS),
      withTimeout(fetchUWCU(),          TIMEOUT_MS),
    ]);

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

// Associated Bank — labeled Interest Rate/APR near "30 Year Fixed"
async function fetchAssociatedBank() {
  const url = "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24";
  const html = await fetchText(url);
  const block = extractThirtyYearBlock(html);

  const interest = findPercent(block, /(Interest\s*Rate|Rate)\s*:?\s*(\d{1,2}\.\d{1,3})\s*%/i);
  const apr      = findPercent(block, /\bAPR\b\s*:?\s*(\d{1,2}\.\d{1,3})\s*%/i);
  const duo      = (interest == null || apr == null) ? twoPercentsNearby(block) : null;

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

// Landmark Credit Union — hardened parser + optional env var override
async function fetchLandmarkCU() {
  const url = "https://landmarkcu.com/mortgage-rates";

  // 0) Env override takes precedence if set
  const envRate = toNum(process.env.LCU_RATE);
  const envApr  = toNum(process.env.LCU_APR);
  if (inRange(envRate) || inRange(envApr)) {
    const final = normalizeRateApr(inRange(envRate) ? envRate : undefined, inRange(envApr) ? envApr : undefined);
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

  // 1) Live parse
  const html = await fetchText(url);
  const clean = html.replace(/\s+/g, " ");

  // A) Try a table-row style capture: "<tr>...30 Year Fixed...<td>Rate</td><td>APR</td>"
  let block = captureAround(clean, /30\s*(?:year|yr)\s*fixed/i, 1600);

  // Pull labeled first
  let interest = findPercent(block, /(Interest\s*Rate|Rate)\s*:?\s*(\d{1,2}\.\d{1,3})\s*%/i);
  let apr      = findPercent(block, /\bAPR\b\s*:?\s*(\d{1,2}\.\d{1,3})\s*%/i);

  // If that failed, try structured HTML cell pattern near the product name
  if (interest == null || apr == null) {
    const rowMatch =
      block.match(/(?:30\s*(?:year|yr)\s*fixed)[^<]{0,400}?(?:<\/?(?:td|th)[^>]*>){0,2}[^%]*?(\d{1,2}\.\d{1,3})\s*%[^%]{0,120}?(\d{1,2}\.\d{1,3})\s*%/i);
    if (rowMatch) {
      const a = parseFloat(rowMatch[1]);
      const b = parseFloat(rowMatch[2]);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        // Smaller is base rate, larger is APR
        interest = trim(Math.min(a, b));
        apr      = trim(Math.max(a, b));
      }
    }
  }

  // Last resort: two percents near each other
  const duo = (interest == null || apr == null) ? twoPercentsNearby(block) : null;

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

// UW Credit Union — “30-Year Fixed Rate Purchase” block
async function fetchUWCU() {
  const url = "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate";
  const html = await fetchText(url);

  const clean = html.replace(/\s+/g, " ");
  const match = clean.match(/30[-\s]?Year\s+Fixed\s+Rate\s+Purchase[^]{0,1200}/i);
  const block = match ? match[0] : extractThirtyYearBlock(clean);

  const rate = findPercent(block, /Rate[^0-9]{0,20}(\d{1,2}\.\d{1,3})\s*%/i);
  const apr  = findPercent(block, /\bAPR\b[^0-9]{0,20}(\d{1,2}\.\d{1,3})\s*%/i);

  const final = normalizeRateApr(inRange(rate) ? rate : undefined, inRange(apr) ? apr : undefined);

  return {
    name: "UW Credit Union",
    product: "30 yr fixed",
    rate: final.rate,
    apr: final.apr,
    url,
    contactUrl: "https://www.uwcu.org/",
    updatedAt: new Date().toISOString(),
    order: 3
  };
}

/* ---------------- Parsing helpers ---------------- */

function extractThirtyYearBlock(html) {
  const clean = html.replace(/\s+/g, " ");
  const m = clean.match(/30\s*(?:year|yr)\s*(?:fixed)?[^]{0,1800}/i);
  return m ? m[0] : clean.slice(0, 2000);
}

function captureAround(txt, re, span = 1500) {
  const m = txt.match(re);
  if (!m) return txt.slice(0, span);
  const i = m.index ?? 0;
  return txt.slice(Math.max(0, i), Math.min(txt.length, i + span));
}

function findPercent(txt, re) {
  const m = txt.match(re);
  if (!m) return null;
  const raw = m[2] ?? m[1];
  const n = parseFloat(raw);
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
  if (rate != null && apr == null) return { rate, apr: undefined };
  if (rate == null && apr != null) return { rate: apr, apr }; // show APR as main if no base
  if (rate != null && apr != null) {
    if (parseFloat(apr) < parseFloat(rate)) return { rate: apr, apr: rate };
    return { rate, apr };
  }
  return { rate: undefined, apr: undefined };
}

function inRange(n) {
  const x = parseFloat(n);
  return Number.isFinite(x) && x >= 2 && x <= 20;
}

function trim(n) { return n.toFixed(3).replace(/0{1,2}$/, ""); }
function toNum(v) { if (v == null) return undefined; const n = Number(String(v).replace(/[^\d.]/g, "")); return Number.isFinite(n) ? n : undefined; }

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

// De-dup by name; prefer entries that have a base rate
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

/* ---------------- Fallback ---------------- */

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
    },
    {
      name: "UW Credit Union",
      product: "30 yr fixed",
      rate: "6.000",
      apr:  "6.047",
      url: "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate",
      contactUrl: "https://www.uwcu.org/",
      updatedAt: now,
      order: 3
    }
  ];
}
