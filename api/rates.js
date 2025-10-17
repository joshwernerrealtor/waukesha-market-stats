// pages/api/rates.js
// Three lenders with hardened parsing + per-lender env overrides + debug.
// Debug URLs:
//   /api/rates?debug=ab
//   /api/rates?debug=landmark
//   /api/rates?debug=uwcu
//   /api/rates?debug=all

const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes
const TIMEOUT_MS   = 7000;
const MAX_LENDERS  = 3;

let CACHE = { ts: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  const url = new URL(req.url, "http://localhost");
  const debug = url.searchParams.get("debug"); // 'ab' | 'landmark' | 'uwcu' | 'all' | null

  // serve warm cache unless debugging
  const now = Date.now();
  if (!debug && CACHE.data && now - CACHE.ts < CACHE_TTL_MS) {
    return res.status(200).json(CACHE.data);
  }

  try {
    const [ab, lcu, uw] = await Promise.all([
      withTimeout(fetchAssociatedBank({ debug: debug === "ab" || debug === "all" }), TIMEOUT_MS).catch(() => null),
      withTimeout(fetchLandmarkCU({ debug: debug === "landmark" || debug === "all" }), TIMEOUT_MS).catch(() => null),
      withTimeout(fetchUWCU({ debug: debug === "uwcu" || debug === "all" }), TIMEOUT_MS).catch(() => null),
    ]);

    // if debugging, show the selected lender’s debug payload instead of the list
    if (debug === "ab"   && ab?.__debug)   return res.status(200).json(ab.__debug);
    if (debug === "landmark" && lcu?.__debug) return res.status(200).json(lcu.__debug);
    if (debug === "uwcu" && uw?.__debug)   return res.status(200).json(uw.__debug);
    if (debug === "all") {
      return res.status(200).json({
        ab: ab?.__debug ?? null,
        landmark: lcu?.__debug ?? null,
        uwcu: uw?.__debug ?? null
      });
    }

    // keep lenders that have at least rate or apr
    const list = [ab, lcu, uw].filter(Boolean).filter(x => x.rate || x.apr);

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

/* ================= Providers ================= */

// ---------- Associated Bank ----------
async function fetchAssociatedBank({ debug = false } = {}) {
  // Env override wins
  const envRate = toNum(process.env.AB_RATE);
  const envApr  = toNum(process.env.AB_APR);
  if (inRange(envRate) || inRange(envApr)) {
    const final = normalizeRateApr(envRate, envApr);
    return base("Associated Bank", final.rate, final.apr,
      "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24",
      1);
  }

  const url = "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24";
  const html = await fetchText(url);
  const block = extractThirtyYearBlock(html);

  const interest = findPercent(block, /(Interest\s*Rate|Rate)\s*:?\s*([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const apr      = findPercent(block, /\bAPR\b\s*:?\s*([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const duo      = (interest == null || apr == null) ? twoPercentsNearby(block) : null;

  const final = normalizeRateApr(pick(interest, duo?.base), pick(apr, duo?.apr));
  const payload = base("Associated Bank", final.rate, final.apr, url, 1);

  if (debug) payload.__debug = { lender: "AB", snippet: block.slice(0,1200), parsed: { interest, apr, duo }, final };
  return payload;
}

// ---------- Landmark Credit Union ----------
async function fetchLandmarkCU({ debug = false } = {}) {
  // Env override wins
  const envRate = toNum(process.env.LCU_RATE);
  const envApr  = toNum(process.env.LCU_APR);
  if (inRange(envRate) || inRange(envApr)) {
    const final = normalizeRateApr(envRate, envApr);
    return base("Landmark Credit Union", final.rate, final.apr,
      "https://landmarkcu.com/rates/mortgage-rates", 2);
  }

  const candidates = [
    "https://landmarkcu.com/rates/mortgage-rates",
    "https://landmarkcu.com/mortgage-rates"
  ];

  let chosenUrl = null, block = "", rate = null, apr = null, duo = null;

  for (const url of candidates) {
    try {
      const html = await fetchText(url);
      const clean = html.replace(/\s+/g, " ");
      block = captureAroundAny(clean, [
        /30\s*(?:year|yr)\s*(?:fixed)/i,
        /fixed\s*30\s*(?:year|yr)/i
      ], 2200);

      rate = findPercent(block, /(Interest\s*Rate|^|\bRate\b)[^0-9]{0,24}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
      apr  = findPercent(block, /\bAPR\b[^0-9]{0,24}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);

      if (rate == null || apr == null) {
        const row = block.match(/(?:30\s*(?:year|yr)\s*fixed|fixed\s*30\s*(?:year|yr))[^%]{0,500}?([0-9]{1,2}\.[0-9]{1,3})\s*%[^%]{0,120}?([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
        if (row) {
          const a = parseFloat(row[1]), b = parseFloat(row[2]);
          if (isFinite(a) && isFinite(b)) { rate = trim(Math.min(a,b)); apr = trim(Math.max(a,b)); }
        }
      }

      if (rate == null || apr == null) duo = twoPercentsNearby(block);

      if (rate || apr || duo) { chosenUrl = url; break; }
    } catch {/* try next */}
  }

  if (!chosenUrl) {
    // we could not read numbers server-side; return null so it doesn't block others
    if (debug) return { __debug: { lender: "Landmark", note: "no SSR numbers", snippet: block.slice(0,1000) } };
    return null;
  }

  const final = normalizeRateApr(pick(rate, duo?.base), pick(apr, duo?.apr));
  const payload = base("Landmark Credit Union", final.rate, final.apr, chosenUrl, 2);

  if (debug) payload.__debug = { lender: "Landmark", snippet: block.slice(0,1200), parsed: { rate, apr, duo }, final };
  return payload;
}

// ---------- UW Credit Union ----------
async function fetchUWCU({ debug = false } = {}) {
  // Env override wins
  const envRate = toNum(process.env.UWCU_RATE);
  const envApr  = toNum(process.env.UWCU_APR);
  if (inRange(envRate) || inRange(envApr)) {
    const final = normalizeRateApr(envRate, envApr);
    return base("UW Credit Union", final.rate, final.apr,
      "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate", 3);
  }

  const url = "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate";
  const html = await fetchText(url);
  const clean = html.replace(/\s+/g, " ");
  const match = clean.match(/30[-\s]?Year\s+Fixed\s+Rate\s+Purchase[^]{0,1200}/i);
  const block = match ? match[0] : extractThirtyYearBlock(clean);

  const rate = findPercent(block, /Rate[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const apr  = findPercent(block, /\bAPR\b[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);

  const final = normalizeRateApr(rate, apr);
  const payload = base("UW Credit Union", final.rate, final.apr, url, 3);

  if (debug) payload.__debug = { lender: "UWCU", snippet: block.slice(0,1200), parsed: { rate, apr }, final };
  return payload;
}

/* ================= Helpers ================= */

function base(name, rate, apr, url, order) {
  return { name, product: "30 yr fixed", rate, apr, url, contactUrl: url, updatedAt: new Date().toISOString(), order };
}

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

function trim(n) { return Number(n).toFixed(3).replace(/0{1,2}$/, ""); }

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

/* fallback only if literally nothing parsed */
function fallbackSample() {
  const now = new Date().toISOString();
  return [
    { name: "Associated Bank", product: "30 yr fixed", rate: "6.125", apr: "6.250",
      url: "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24",
      contactUrl: "https://www.associatedbank.com/personal/loans/home-loans", updatedAt: now, order: 1 },
    { name: "Landmark Credit Union", product: "30 yr fixed", rate: "6.875", apr: "6.990",
      url: "https://landmarkcu.com/rates/mortgage-rates",
      contactUrl: "https://landmarkcu.com/mortgage", updatedAt: now, order: 2 },
    { name: "UW Credit Union", product: "30 yr fixed", rate: "6.000", apr: "6.047",
      url: "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate",
      contactUrl: "https://www.uwcu.org/", updatedAt: now, order: 3 }
  ];
}
