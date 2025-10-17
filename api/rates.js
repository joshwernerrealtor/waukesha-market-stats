// pages/api/rates.js
// Lenders: Associated Bank + Landmark CU + UW Credit Union.
// Landmark parser hardened; env override; debug mode.
//
// Debug mode:
//   /api/rates?debug=landmark   -> returns the snippet we parsed + numbers
//
// Env (optional, takes precedence for Landmark):
//   LCU_RATE=6.125
//   LCU_APR=6.240

const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes
const TIMEOUT_MS   = 7000;
const MAX_LENDERS  = 3;

let CACHE = { ts: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  // Quick debug hook for Landmark
  const urlDebug = new URL(req.url, "http://localhost");
  const debugTarget = urlDebug.searchParams.get("debug");

  // Warm in-memory cache
  const now = Date.now();
  if (!debugTarget && CACHE.data && now - CACHE.ts < CACHE_TTL_MS) {
    return res.status(200).json(CACHE.data);
  }

  try {
    const [ab, lcu, uw] = await Promise.all([
      withTimeout(fetchAssociatedBank(), TIMEOUT_MS).catch(() => null),
      withTimeout(fetchLandmarkCU({ debug: debugTarget === "landmark" }), TIMEOUT_MS).catch(() => null),
      withTimeout(fetchUWCU(), TIMEOUT_MS).catch(() => null),
    ]);

    // Debug mode: show raw snippet for Landmark
    if (debugTarget === "landmark" && lcu && lcu.__debug) {
      return res.status(200).json(lcu.__debug);
    }

    const list = [ab, lcu, uw].filter(Boolean).filter(x => x.rate || x.apr);

    const lenders = dedupeByName(list)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
      .slice(0, MAX_LENDERS);

    const payload = {
      generatedAt: new Date().toISOString(),
      lenders: lenders.length ? lenders : fallbackSample().slice(0, MAX_LENDERS)
    };

    if (!debugTarget) CACHE = { ts: now, data: payload };
    return res.status(200).json(payload);
  } catch {
    const payload = {
      generatedAt: new Date().toISOString(),
      lenders: fallbackSample().slice(0, MAX_LENDERS),
      error: "partial"
    };
    if (!debugTarget) CACHE = { ts: now, data: payload };
    return res.status(200).json(payload);
  }
}

/* ---------------- Providers ---------------- */

async function fetchAssociatedBank() {
  const url = "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24";
  const html = await fetchText(url);
  const block = extractThirtyYearBlock(html);

  const interest = findPercent(block, /(Interest\s*Rate|Rate)\s*:?\s*([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const apr      = findPercent(block, /\bAPR\b\s*:?\s*([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const duo      = (interest == null || apr == null) ? twoPercentsNearby(block) : null;

  const final = normalizeRateApr(pick(interest, duo?.base), pick(apr, duo?.apr));

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

// Landmark CU — hardened parser with env override + debug payload
async function fetchLandmarkCU({ debug = false } = {}) {
  const url = "https://landmarkcu.com/mortgage-rates";

  // 0) Env override wins instantly
  const envRate = toNum(process.env.LCU_RATE);
  const envApr  = toNum(process.env.LCU_APR);
  if (inRange(envRate) || inRange(envApr)) {
    const final = normalizeRateApr(envRate, envApr);
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
  // Landmark sometimes puts the product text like "30 Year Fixed" or "Fixed 30 Year"
  const block = captureAroundAny(clean, [
    /30\s*(?:year|yr)\s*(?:fixed)/i,
    /fixed\s*30\s*(?:year|yr)/i
  ], 2000);

  // Strategy: try in this order
  // A) Labeled "Rate" and "APR" nearby
  let rate = findPercent(block, /(Interest\s*Rate|^|\bRate\b)[^0-9]{0,24}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  let apr  = findPercent(block, /\bAPR\b[^0-9]{0,24}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);

  // B) Table-like capture: cells after the product name contain two percents
  if (rate == null || apr == null) {
    const row = block.match(/(?:30\s*(?:year|yr)\s*fixed|fixed\s*30\s*(?:year|yr))[^%]{0,500}?([0-9]{1,2}\.[0-9]{1,3})\s*%[^%]{0,120}?([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
    if (row) {
      const a = parseFloat(row[1]), b = parseFloat(row[2]);
      if (isFinite(a) && isFinite(b)) {
        // smaller is base, bigger is APR
        rate = trim(Math.min(a, b));
        apr  = trim(Math.max(a, b));
      }
    }
  }

  // C) Last resort: two percents near each other in the block
  const duo = (rate == null || apr == null) ? twoPercentsNearby(block) : null;
  const final = normalizeRateApr(pick(rate, duo?.base), pick(apr, duo?.apr));

  const payload = {
    name: "Landmark Credit Union",
    product: "30 yr fixed",
    rate: final.rate,
    apr: final.apr,
    url,
    contactUrl: "https://landmarkcu.com/mortgage",
    updatedAt: new Date().toISOString(),
    order: 2
  };

  if (debug) {
    payload.__debug = {
      message: "Landmark parser debug",
      snippet: block.slice(0, 1200),
      parsed: { rate, apr, duo },
      final
    };
  }

  return payload;
}

async function fetchUWCU() {
  const url = "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate";
  const html = await fetchText(url);

  const clean = html.replace(/\s+/g, " ");
  const match = clean.match(/30[-\s]?Year\s+Fixed\s+Rate\s+Purchase[^]{0,1200}/i);
  const block = match ? match[0] : extractThirtyYearBlock(clean);

  const rate = findPercent(block, /Rate[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const apr  = findPercent(block, /\bAPR\b[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);

  const final = normalizeRateApr(rate, apr);

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

/* ---------------- Helpers ---------------- */

function extractThirtyYearBlock(html) {
  const clean = html.replace(/\s+/g, " ");
  const m = clean.match(/30\s*(?:year|yr)\s*(?:fixed)?[^]{0,1800}/i);
  return m ? m[0] : clean.slice(0, 2000);
}

function captureAroundAny(txt, regexes, span = 1500) {
  for (const re of regexes) {
    const m = txt.match(re);
    if (m) {
      const i = m.index ?? 0;
      return txt.slice(Math.max(0, i), Math.min(txt.length, i + span));
    }
  }
  return txt.slice(0, span);
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
    txt.match(/([0-9]{1,2}\.[0-9]{1,3})\s*%[^%]{0,140}?(?:APR|A\.?P\.?R\.?)\s*([0-9]{1,2}\.[0-9]{1,3})\s*%/i) ||
    txt.match(/(?:APR|A\.?P\.?R\.?)\s*([0-9]{1,2}\.[0-9]{1,3})\s*%[^%]{0,140}?([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const base = Math.min(a, b);
  const apr  = Math.max(a, b);
  return { base: trim(base), apr: trim(apr) };
}

function normalizeRateApr(rate, apr) {
  // use whichever is present; if both, ensure APR >= base
  if (rate != null && apr == null) return { rate, apr: undefined };
  if (rate == null && apr != null) return { rate: apr, apr };
  if (rate != null && apr != null) {
    if (parseFloat(apr) < parseFloat(rate)) return { rate: apr, apr: rate };
    return { rate, apr };
  }
  return { rate: undefined, apr: undefined };
}

function pick(a, b) {
  const A = toNum(a), B = toNum(b);
  if (inRange(A)) return trim(A);
  if (inRange(B)) return trim(B);
  return undefined;
}

function inRange(n) {
  const x = parseFloat(n);
  return Number.isFinite(x) && x >= 2 && x <= 20;
}

function trim(n) {
  return Number(n).toFixed(3).replace(/0{1,2}$/, "");
}

function toNum(v) {
  if (v == null) return undefined;
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

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
