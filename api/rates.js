// pages/api/rates.js
// Associated Bank + UW Credit Union + Summit Credit Union (via RatesCentral JSON).
// Summit uses: https://ratescentral.summitcreditunion.com/api/website/3Uw4xUFQt1EVCMpYRJuXKx/index.json[?ts]
// Debug: /api/rates?debug=summit (or ab | uwcu | all)

const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes
const TIMEOUT_MS   = 7000;
const MAX_LENDERS  = 3;

let CACHE = { ts: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  const url = new URL(req.url, "http://localhost");
  const debug = url.searchParams.get("debug"); // 'summet' typo-safe handled below

  const now = Date.now();
  if (!debug && CACHE.data && now - CACHE.ts < CACHE_TTL_MS) {
    return res.status(200).json(CACHE.data);
  }

  try {
    const [ab, uw, sc] = await Promise.all([
      withTimeout(fetchAssociatedBank({ debug: debug === "ab" || debug === "all" }), TIMEOUT_MS).catch(() => null),
      withTimeout(fetchUWCU({ debug: debug === "uwcu" || debug === "all" }), TIMEOUT_MS).catch(() => null),
      withTimeout(fetchSummitJSON({ debug: debug === "summit" || debug === "all" }), TIMEOUT_MS).catch(() => null),
    ]);

    // Debug taps
    if (debug === "ab"    && ab?.__debug)   return res.status(200).json(ab.__debug);
    if (debug === "uwcu"  && uw?.__debug)   return res.status(200).json(uw.__debug);
    if (debug === "summit"&& sc?.__debug)   return res.status(200).json(sc.__debug);
    if (debug === "all")  return res.status(200).json({ ab: ab?.__debug ?? null, uwcu: uw?.__debug ?? null, summit: sc?.__debug ?? null });

    const list = [ab, uw, sc].filter(Boolean).filter(x => x.rate || x.apr);

    const lenders = list
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
      .slice(0, MAX_LENDERS);

    const payload = {
      generatedAt: new Date().toISOString(),
      lenders: lenders.length ? lenders : fallbackSample().slice(0, MAX_LENDERS)
    };

    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  } catch {
    const payload = { generatedAt: new Date().toISOString(), lenders: fallbackSample().slice(0, MAX_LENDERS), error: "partial" };
    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  }
}

/* ================= Providers ================= */

// ---------- Associated Bank (HTML) ----------
async function fetchAssociatedBank({ debug = false } = {}) {
  const envRate = toNum(process.env.AB_RATE);
  const envApr  = toNum(process.env.AB_APR);
  if (inRange(envRate) || inRange(envApr)) {
    const final = normalizeRateApr(envRate, envApr);
    return base("Associated Bank", final.rate, final.apr,
      "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24", 1);
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

// ---------- UW Credit Union (HTML) ----------
async function fetchUWCU({ debug = false } = {}) {
  const envRate = toNum(process.env.UWCU_RATE);
  const envApr  = toNum(process.env.UWCU_APR);
  if (inRange(envRate) || inRange(envApr)) {
    const final = normalizeRateApr(envRate, envApr);
    return base("UW Credit Union", final.rate, final.apr,
      "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate", 2);
  }

  const url = "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate";
  const html = await fetchText(url);
  const clean = html.replace(/\s+/g, " ");
  const match = clean.match(/30[-\s]?Year\s+Fixed\s+Rate\s+Purchase[^]{0,1200}/i);
  const block = match ? match[0] : extractThirtyYearBlock(clean);

  const rate = findPercent(block, /Rate[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const apr  = findPercent(block, /\bAPR\b[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);

  const final = normalizeRateApr(rate, apr);
  const payload = base("UW Credit Union", final.rate, final.apr, url, 2);

  if (debug) payload.__debug = { lender: "UWCU", snippet: block.slice(0,1200), parsed: { rate, apr }, final };
  return payload;
}

// ---------- Summit Credit Union (RatesCentral JSON) ----------
async function fetchSummitJSON({ debug = false } = {}) {
  // Optional env override
  const envRate = toNum(process.env.SUMMIT_RATE);
  const envApr  = toNum(process.env.SUMMIT_APR);
  const override = inRange(envRate) || inRange(envApr);

  // Their JSON endpoint (thanks, Josh)
  const baseUrl = "https://ratescentral.summitcreditunion.com/api/website/3Uw4xUFQt1EVCMpYRJuXKx/index.json";

  // Try with ts param then without; send a referer + accept headers
  let json = null, usedUrl = null, error = null;
  for (const candidate of [`${baseUrl}?${Date.now()}`, baseUrl]) {
    try {
      json = await fetchJSON(candidate, {
        headers: {
          "accept": "application/json",
          "referer": "https://www.summitcreditunion.com/",
          "user-agent": "Mozilla/5.0 ratesbot"
        }
      });
      usedUrl = candidate;
      break;
    } catch (e) {
      error = e;
    }
  }

  // If JSON failed but overrides exist, return override
  if (!json) {
    if (override) {
      const final = normalizeRateApr(envRate, envApr);
      const payload = base("Summit Credit Union", final.rate, final.apr,
        "https://www.summitcreditunion.com/borrow/mortgage-loan/#mortgage-rates", 3);
      if (debug) payload.__debug = { lender: "Summit", note: "used env override", error: String(error) };
      return payload;
    }
    // No data at all → skip Summit
    if (debug) return { __debug: { lender: "Summit", note: "JSON fetch failed and no override", error: String(error) } };
    return null;
  }

  // Heuristic: walk the JSON for an object representing 30-year fixed mortgage with labeled rate/APR.
  const pick = findThirtyFixed(json);

  const final = normalizeRateApr(toNum(pick?.rate), toNum(pick?.apr));
  const payload = base("Summit Credit Union", final.rate, final.apr,
    "https://www.summitcreditunion.com/borrow/mortgage-loan/#mortgage-rates", 3);

  if (debug) {
    payload.__debug = {
      lender: "Summit",
      usedUrl,
      sample: stringifySample(json),
      selected: pick,
      final
    };
  }
  // If we still failed to find numbers and no override, drop Summit to avoid junk
  if (!payload.rate && !override) return debug ? payload : null;

  // If numbers missing but override exists, merge it
  if (!payload.rate && override) {
    const merged = normalizeRateApr(envRate, envApr);
    payload.rate = merged.rate; payload.apr = merged.apr;
  }

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

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`Bad JSON ${res.status} for ${url}`);
  return res.json();
}

async function withTimeout(promise, ms) {
  return await Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

/* ---- Summit JSON traversal ----
   We don't know their exact shape forever, so:
   - scan for items whose label/title includes "30" and "Fixed"
   - pick fields named like rate/apr/interest
   - prefer smaller number as base rate if two percents found
*/
function findThirtyFixed(json) {
  let best = null;

  walk(json, (obj) => {
    if (typeof obj !== "object" || !obj) return;

    const text = [
      obj.title, obj.name, obj.label, obj.product, obj.header,
      Array.isArray(obj.tags) ? obj.tags.join(" ") : ""
    ].filter(Boolean).join(" ").toLowerCase();

    const looksLikeThirtyFixed =
      /\b30\b/.test(text) && /fix/.test(text) && /mortg|home|loan|rate/.test(text);

    if (!looksLikeThirtyFixed) return;

    const rateLike = pickField(obj, ["rate", "interest", "interestRate", "baseRate"]);
    const aprLike  = pickField(obj, ["apr", "a.p.r", "annualPercentageRate"]);

    // If not found directly, scan nested value strings for percents
    let rate = toNum(rateLike);
    let apr  = toNum(aprLike);

    if (!rate || !apr) {
      const pair = twoPercentsNearby(JSON.stringify(obj));
      if (pair) {
        if (!rate) rate = toNum(pair.base);
        if (!apr)  apr  = toNum(pair.apr);
      }
    }

    if (rate || apr) {
      const final = normalizeRateApr(rate, apr);
      best = best || { rate: final.rate, apr: final.apr, raw: obj };
    }
  });

  return best;
}

function pickField(obj, names) {
  for (const key of Object.keys(obj)) {
    const low = key.toLowerCase();
    if (names.some(n => low.includes(n))) return obj[key];
  }
  return undefined;
}

function walk(node, fn) {
  fn(node);
  if (Array.isArray(node)) { for (const v of node) walk(v, fn); }
  else if (node && typeof node === "object") {
    for (const k of Object.keys(node)) walk(node[k], fn);
  }
}

function stringifySample(json) {
  try {
    const s = JSON.stringify(json);
    return s.length > 2000 ? s.slice(0, 2000) + "…(truncated)" : s;
  } catch { return ""; }
}

/* ---- Fallback ---- */
function fallbackSample() {
  const now = new Date().toISOString();
  return [
    { name: "Associated Bank", product: "30 yr fixed", rate: "6.125", apr: "6.250",
      url: "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24",
      contactUrl: "https://www.associatedbank.com/personal/loans/home-loans", updatedAt: now, order: 1 },
    { name: "UW Credit Union", product: "30 yr fixed", rate: "6.000", apr: "6.047",
      url: "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate",
      contactUrl: "https://www.uwcu.org/", updatedAt: now, order: 2 },
    { name: "Summit Credit Union", product: "30 yr fixed", rate: undefined, apr: undefined,
      url: "https://www.summitcreditunion.com/borrow/mortgage-loan/#mortgage-rates",
      contactUrl: "https://www.summitcreditunion.com/borrow/mortgage-loan/#mortgage-rates", updatedAt: now, order: 3 },
  ];
}
