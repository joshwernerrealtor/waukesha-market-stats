// pages/api/rates.js
// Lenders: Associated Bank + UW Credit Union + Summit Credit Union (RatesCentral JSON)
// Always returns all three lenders by merging live parses with sane fallbacks.
// Optional env overrides: AB_RATE, AB_APR, UWCU_RATE, UWCU_APR, SUMMIT_RATE, SUMMIT_APR
// Debug: /api/rates?debug=ab | uwcu | summit | all

const CACHE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS   = 7000;
const MAX_LENDERS  = 3;

let CACHE = { ts: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  const url = new URL(req.url, "http://localhost");
  const debug = url.searchParams.get("debug");
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
    if (debug === "ab"     && ab?.__debug)   return res.status(200).json(ab.__debug);
    if (debug === "uwcu"   && uw?.__debug)   return res.status(200).json(uw.__debug);
    if (debug === "summit" && sc?.__debug)   return res.status(200).json(sc.__debug);
    if (debug === "all") {
      return res.status(200).json({
        ab: ab?.__debug ?? null,
        uwcu: uw?.__debug ?? null,
        summit: sc?.__debug ?? null
      });
    }

    // Always return all three lenders by merging with fallbacks
    const FALLBACKS = Object.fromEntries(fallbackSample().map(f => [f.name, f]));
    const merged = {
      "Associated Bank":   ab ?? FALLBACKS["Associated Bank"],
      "UW Credit Union":   uw ?? FALLBACKS["UW Credit Union"],
      "Summit Credit Union": sc ?? FALLBACKS["Summit Credit Union"],
    };

    const lenders = [
      merged["Associated Bank"],
      merged["UW Credit Union"],
      merged["Summit Credit Union"],
    ].filter(Boolean).slice(0, MAX_LENDERS);

    const payload = {
      generatedAt: new Date().toISOString(),
      lenders
    };

    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  } catch (err) {
    // Worst case: always return three from fallback
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      lenders: fallbackSample().slice(0, MAX_LENDERS),
      error: String(err)
    });
  }
}

/* ================= Providers ================= */

/* ---------- Associated Bank (HTML + env override) ---------- */
async function fetchAssociatedBank({ debug = false } = {}) {
  // Env override wins, because accuracy beats vibes
  const envRate = toNum(process.env.AB_RATE);
  const envApr  = toNum(process.env.AB_APR);
  if (inRange(envRate) || inRange(envApr)) {
    const final = normalizeRateApr(envRate, envApr);
    return base("Associated Bank", final.rate, final.apr,
      "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24", 1);
  }

  // Best-effort HTML parsing
  const url = "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24";
  const html = await fetchText(url);
  const block = extractThirtyYearBlock(html);

  const interest = findPercent(block, /(Interest\s*Rate|Rate)\s*:?\s*([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const apr      = findPercent(block, /\bAPR\b\s*:?\s*([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const duo      = (interest == null || apr == null) ? twoPercentsNearby(block) : null;

  const final = normalizeRateApr(pick(interest, duo?.base), pick(apr, duo?.apr));
  const payload = base("Associated Bank", final.rate, final.apr, url, 1);

  if (debug) payload.__debug = { lender: "AB", snippet: block.slice(0, 1000), parsed: { interest, apr, duo }, final };
  return payload;
}

/* ---------- UW Credit Union (robust HTML + env override) ---------- */
async function fetchUWCU({ debug = false } = {}) {
  // Env override wins
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

  // Grab the 30-Year Fixed block then peel numbers from .rate_number
  const match = clean.match(/30[-\s]?Year\s+Fixed\s+Rate\s+Purchase[^]{0,1500}/i);
  const block = match ? match[0] : extractThirtyYearBlock(clean);

  const nums = [];
  const reNum = /rate_number">\s*([0-9]{1,2}\.[0-9]{1,3})\s*</gi;
  let m;
  while ((m = reNum.exec(block)) && nums.length < 3) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n)) nums.push(n);
  }

  // Primary numbers from the DOM structure
  let rate = nums[0];
  let apr  = nums[1];

  // Fallback regexes if DOM shape shifts
  if (!inRange(rate) || !inRange(apr)) {
    const fbRate = findPercent(block, /Rate[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
    const fbApr  = findPercent(block, /\bAPR\b[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
    rate = pick(rate, fbRate);
    apr  = pick(apr,  fbApr);
  }

  const final = normalizeRateApr(rate, apr);
  const payload = base("UW Credit Union", final.rate, final.apr, url, 2);

  if (debug) payload.__debug = { lender: "UWCU", snippet: block.slice(0, 1000), parsed: { nums, rate: final.rate, apr: final.apr } };
  return payload;
}

/* ---------- Summit Credit Union (RatesCentral JSON + env override) ---------- */
async function fetchSummitJSON({ debug = false } = {}) {
  const envRate = toNum(process.env.SUMMIT_RATE);
  const envApr  = toNum(process.env.SUMMIT_APR);
  const hasOverride = inRange(envRate) || inRange(envApr);

  const baseUrl = "https://ratescentral.summitcreditunion.com/api/website/3Uw4xUFQt1EVCMpYRJuXKx/index.json";

  let json = null, usedUrl = null, lastErr = null;
  for (const candidate of [`${baseUrl}?ts=${Date.now()}`, baseUrl]) {
    try {
      json = await fetchJSON(candidate, {
        headers: {
          "accept": "application/json",
          "referer": "https://www.summitcreditunion.com/",
          "user-agent": "Mozilla/5.0 ratesbot"
        },
        cache: "no-store"
      });
      usedUrl = candidate;
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!json && !hasOverride) {
    if (debug) return { __debug: { lender: "Summit", note: "JSON fetch failed; no override", error: String(lastErr) } };
    return null;
  }

  const pickObj = json ? pickSummitThirtyFixed(json) : null;

  let rateNum = toNum(pickObj?.rate);
  let aprNum  = toNum(pickObj?.apr);

  // If either missing and we have overrides, merge them in
  if ((!inRange(rateNum) && hasOverride) || (!inRange(aprNum) && hasOverride)) {
    rateNum = inRange(rateNum) ? rateNum : envRate;
    aprNum  = inRange(aprNum)  ? aprNum  : envApr;
  }

  // If still nothing usable, drop Summit quietly
  if (!inRange(rateNum) && !inRange(aprNum)) {
    if (debug) return { __debug: { lender: "Summit", usedUrl, note: "no 30yr fixed found", sample: stringifySample(json) } };
    return null;
  }

  const final = normalizeRateApr(rateNum, aprNum);
  const payload = base("Summit Credit Union", final.rate, final.apr,
    "https://www.summitcreditunion.com/borrow/mortgage-loan/#mortgage-rates", 3);

  if (debug) payload.__debug = { lender: "Summit", usedUrl, selected: pickObj, final };
  return payload;
}

/* ================= Summit-specific picker ================= */
/*
Structure (simplified):
[
  {
    "title": "Mortgage Rates",
    "fields": [
      { "title": "Type and Term", "values": [ { rateId:"...", value:"30 Year Fixed" }, ... ] },
      { "title": "Rate",          "values": [ { rateId:"...", value:"6.000%" }, ... ] },
      { "title": "APR",           "values": [ { rateId:"...", value:"6.047%" }, ... ] }
    ]
  }
]
We link the "30 Year Fixed" rateId to matching Rate/APR entries.
*/
function pickSummitThirtyFixed(json) {
  const asArray = v => Array.isArray(v) ? v : (v == null ? [] : [v]);
  const blocks = [];
  walk(json, node => {
    if (node && typeof node === "object" && Array.isArray(node.fields) && node.fields.length) {
      blocks.push(node);
    }
  });

  for (const block of blocks) {
    const fields = asArray(block.fields);

    const termField = fields.find(f => {
      const t = String(f.title || "").toLowerCase();
      return /type.*term|term|product|loan/.test(t);
    });
    if (!termField || !Array.isArray(termField.values)) continue;

    const termEntry = termField.values.find(v => {
      const label = String(v?.value || "").toLowerCase();
      return /\b30\b/.test(label) && /fix/.test(label);
    });
    if (!termEntry?.rateId) continue;

    const rid = termEntry.rateId;
    const rateField = fields.find(f => /(^|\b)rate(s)?\b/i.test(String(f.title || "")));
    const aprField  = fields.find(f => /\bapr\b|annual\s*percentage/i.test(String(f.title || "")));

    const rateVal = rateField?.values?.find(v => v?.rateId === rid)?.value;
    const aprVal  = aprField?.values?.find(v => v?.rateId === rid)?.value;

    const rNum = toNum(rateVal);
    const aNum = toNum(aprVal);

    if (inRange(rNum) || inRange(aNum)) {
      return { rate: rNum, apr: aNum, raw: { rid, rateVal, aprVal } };
    }
  }

  // Last-ditch: two percents near each other anywhere in the blob
  const pair = twoPercentsNearby(JSON.stringify(json));
  if (pair) return { rate: pair.base, apr: pair.apr, raw: { fallback: true } };

  return null;
}

/* ================= Utilities ================= */

function base(name, rate, apr, url, order) {
  return {
    name,
    product: "30 yr fixed",
    rate: rate != null ? trim(rate) : undefined,
    apr:  apr  != null ? trim(apr)  : undefined,
    url,
    contactUrl: url,
    updatedAt: new Date().toISOString(),
    order
  };
}

function normalizeRateApr(rate, apr) {
  // If only APR provided, use it as rate to avoid inverted displays
  if (rate != null && apr == null) return { rate: trim(rate), apr: undefined };
  if (rate == null && apr != null) return { rate: trim(apr),  apr: trim(apr) };
  if (rate != null && apr != null) {
    const r = +rate, a = +apr;
    // Ensure APR isn't below the base rate
    if (isFinite(r) && isFinite(a) && a < r) return { rate: trim(a), apr: trim(r) };
    return { rate: trim(r), apr: trim(a) };
  }
  return { rate: undefined, apr: undefined };
}

function toNum(x) {
  if (x == null) return null;
  const n = parseFloat(String(x).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function trim(n) { return parseFloat(Number(n).toFixed(3)); }
function pick(...v) { return v.find(x => x != null && Number.isFinite(+x)); }
function inRange(n) { return Number.isFinite(n) && n > 1 && n < 20; }

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
  return Number.isFinite(n) ? n : null;
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
  return { base, apr };
}
function stringifySample(o) {
  try { const s = JSON.stringify(o); return s.length > 1200 ? s.slice(0,1200) + "…(truncated)" : s; }
  catch { return String(o); }
}
function walk(o, fn) {
  if (!o || typeof o !== "object") return;
  fn(o);
  if (Array.isArray(o)) { for (const v of o) walk(v, fn); return; }
  for (const v of Object.values(o)) walk(v, fn);
}
async function withTimeout(promise, ms) {
  return await Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
  ]);
}

/* ================= Fallbacks ================= */

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
      name: "UW Credit Union",
      product: "30 yr fixed",
      rate: "6.000",
      apr:  "6.047",
      url: "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate",
      contactUrl: "https://www.uwcu.org/",
      updatedAt: now,
      order: 2
    },
    {
      name: "Summit Credit Union",
      product: "30 yr fixed",
      rate: "6.000",
      apr:  "6.098",
      url: "https://www.summitcreditunion.com/borrow/mortgage-loan/#mortgage-rates",
      contactUrl: "https://www.summitcreditunion.com/borrow/mortgage-loan/#mortgage-rates",
      updatedAt: now,
      order: 3
    }
  ];
}
