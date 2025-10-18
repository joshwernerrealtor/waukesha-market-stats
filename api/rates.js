// pages/api/rates.js
// Lenders: Associated Bank + UW Credit Union + Summit Credit Union (RatesCentral JSON)
// Optional env overrides: AB_RATE, AB_APR, UWCU_RATE, UWCU_APR, SUMMIT_RATE, SUMMIT_APR
// Debug URLs: /api/rates?debug=ab | uwcu | summit | all

const CACHE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 7000;
const MAX_LENDERS = 3;
let CACHE = { ts: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  const url = new URL(req.url, "http://localhost");
  const debug = url.searchParams.get("debug");
  const now = Date.now();

  if (!debug && CACHE.data && now - CACHE.ts < CACHE_TTL_MS)
    return res.status(200).json(CACHE.data);

  try {
    const [ab, uw, sc] = await Promise.all([
      withTimeout(fetchAssociatedBank({ debug: debug === "ab" || debug === "all" }), TIMEOUT_MS).catch(() => null),
      withTimeout(fetchUWCU({ debug: debug === "uwcu" || debug === "all" }), TIMEOUT_MS).catch(() => null),
      withTimeout(fetchSummitJSON({ debug: debug === "summit" || debug === "all" }), TIMEOUT_MS).catch(() => null)
    ]);

    if (debug === "ab" && ab?.__debug) return res.status(200).json(ab.__debug);
    if (debug === "uwcu" && uw?.__debug) return res.status(200).json(uw.__debug);
    if (debug === "summit" && sc?.__debug) return res.status(200).json(sc.__debug);
    if (debug === "all")
      return res.status(200).json({
        ab: ab?.__debug ?? null,
        uwcu: uw?.__debug ?? null,
        summit: sc?.__debug ?? null
      });

    const lenders = [ab, uw, sc].filter(Boolean).filter(x => x.rate || x.apr)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
      .slice(0, MAX_LENDERS);

    const payload = {
      generatedAt: new Date().toISOString(),
      lenders: lenders.length ? lenders : fallbackSample().slice(0, MAX_LENDERS)
    };

    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  } catch (err) {
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      lenders: fallbackSample().slice(0, MAX_LENDERS),
      error: String(err)
    });
  }
}

/* ---------- Associated Bank ---------- */
async function fetchAssociatedBank({ debug = false } = {}) {
  const envRate = toNum(process.env.AB_RATE);
  const envApr = toNum(process.env.AB_APR);
  if (inRange(envRate) || inRange(envApr))
    return base("Associated Bank", envRate, envApr,
      "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24", 1);

  const url = "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24";
  const html = await fetchText(url);
  const block = extractThirtyYearBlock(html);
  const interest = findPercent(block, /(Interest\s*Rate|Rate)\s*:?\s*([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const apr = findPercent(block, /\bAPR\b\s*:?\s*([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const duo = (!interest || !apr) ? twoPercentsNearby(block) : null;
  const final = normalizeRateApr(pick(interest, duo?.base), pick(apr, duo?.apr));
  const payload = base("Associated Bank", final.rate, final.apr, url, 1);
  if (debug) payload.__debug = { lender: "AB", snippet: block.slice(0, 800), parsed: { interest, apr, duo }, final };
  return payload;
}

/* ---------- UW Credit Union ---------- */
async function fetchUWCU({ debug = false } = {}) {
  const envRate = toNum(process.env.UWCU_RATE);
  const envApr = toNum(process.env.UWCU_APR);
  if (inRange(envRate) || inRange(envApr))
    return base("UW Credit Union", envRate, envApr,
      "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate", 2);

  const url = "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate";
  const html = await fetchText(url);
  const clean = html.replace(/\s+/g, " ");
  const match = clean.match(/30[-\s]?Year\s+Fixed\s+Rate\s+Purchase[^]{0,1200}/i);
  const block = match ? match[0] : extractThirtyYearBlock(clean);
  const rate = findPercent(block, /Rate[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const apr = findPercent(block, /\bAPR\b[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  const final = normalizeRateApr(rate, apr);
  const payload = base("UW Credit Union", final.rate, final.apr, url, 2);
  if (debug) payload.__debug = { lender: "UWCU", snippet: block.slice(0, 800), parsed: { rate, apr }, final };
  return payload;
}

/* ---------- Summit Credit Union ---------- */
async function fetchSummitJSON({ debug = false } = {}) {
  const envRate = toNum(process.env.SUMMIT_RATE);
  const envApr = toNum(process.env.SUMMIT_APR);
  const hasOverride = inRange(envRate) || inRange(envApr);
  const baseUrl = "https://ratescentral.summitcreditunion.com/api/website/3Uw4xUFQt1EVCMpYRJuXKx/index.json";

  let json = null, usedUrl = null;
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
    } catch { /* ignore */ }
  }

  if (!json && !hasOverride) return null;
  const pickObj = json ? pickSummitThirtyFixed(json) : null;
  let rateNum = toNum(pickObj?.rate);
  let aprNum = toNum(pickObj?.apr);
  if (!inRange(rateNum) && hasOverride) rateNum = envRate;
  if (!inRange(aprNum) && hasOverride) aprNum = envApr;
  if (!inRange(rateNum) && !inRange(aprNum)) return null;

  const final = normalizeRateApr(rateNum, aprNum);
  const payload = base("Summit Credit Union", final.rate, final.apr,
    "https://www.summitcreditunion.com/borrow/mortgage-loan/#mortgage-rates", 3);
  if (debug) payload.__debug = { lender: "Summit", usedUrl, selected: pickObj, final };
  return payload;
}

/* ---------- Summit-specific JSON picker ---------- */
function pickSummitThirtyFixed(json) {
  const asArray = v => Array.isArray(v) ? v : (v == null ? [] : [v]);
  let candidateBlocks = [];
  walk(json, node => {
    if (node && typeof node === "object" && Array.isArray(node.fields)) candidateBlocks.push(node);
  });

  for (const block of candidateBlocks) {
    const fields = asArray(block.fields);
    const termField = fields.find(f => /term|type/i.test(f.title || ""));
    if (!termField) continue;
    const termEntry = termField.values?.find(v => /\b30\b/.test(v?.value || "") && /fix/i.test(v?.value || ""));
    if (!termEntry?.rateId) continue;
    const rid = termEntry.rateId;
    const rateField = fields.find(f => /rate/i.test(f.title || ""));
    const aprField = fields.find(f => /apr/i.test(f.title || ""));
    const rateVal = rateField?.values?.find(v => v.rateId === rid)?.value;
    const aprVal = aprField?.values?.find(v => v.rateId === rid)?.value;
    const rNum = toNum(rateVal);
    const aNum = toNum(aprVal);
    if (inRange(rNum) || inRange(aNum))
      return { rate: rNum, apr: aNum, raw: { rid, rateVal, aprVal } };
  }
  return null;
}

/* ---------- Utilities ---------- */
function base(name, rate, apr, url, order) {
  return { name, product: "30 yr fixed", rate, apr, url, contactUrl: url, updatedAt: new Date().toISOString(), order };
}

function normalizeRateApr(rate, apr) {
  const r = toNum(rate);
  const a = toNum(apr);
  return { rate: r ? trim(r) : undefined, apr: a ? trim(a) : undefined };
}
function toNum(x) {
  if (x == null) return null;
  const n = parseFloat(String(x).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function trim(n) { return parseFloat(n.toFixed(3)); }
function pick(...v) { return v.find(x => x != null && !isNaN(x)); }
function inRange(n) { return Number.isFinite(n) && n > 1 && n < 20; }

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 ratesbot" } });
  if (!res.ok) throw new Error(res.status);
  return await res.text();
}
async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(res.status);
  return await res.json();
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
  const m = txt.match(/([0-9]{1,2}\.[0-9]{1,3})\s*%[^%]{0,140}?(APR|A\.?P\.?R\.?)\s*([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  if (!m) return null;
  const base = parseFloat(m[1]);
  const apr = parseFloat(m[3]);
  return { base, apr };
}
function stringifySample(o) {
  try { return JSON.stringify(o).slice(0, 800); } catch { return String(o); }
}
function walk(o, fn) {
  if (!o || typeof o !== "object") return;
  fn(o);
  for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, fn);
}
function withTimeout(p, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))])
    .finally(() => clearTimeout(id));
}
function fallbackSample() {
  const now = new Date().toISOString();
  return [
    { name: "Associated Bank", product: "30 yr fixed", rate: "6.125", apr: "6.250", url: "https://www.associatedbank.com/", contactUrl: "https://www.associatedbank.com/", updatedAt: now, order: 1 },
    { name: "UW Credit Union", product: "30 yr fixed", rate: "6.000", apr: "6.047", url: "https://www.uwcu.org/", contactUrl: "https://www.uwcu.org/", updatedAt: now, order: 2 },
    { name: "Summit Credit Union", product: "30 yr fixed", rate: "6.000", apr: "6.098", url: "https://www.summitcreditunion.com/", contactUrl: "https://www.summitcreditunion.com/", updatedAt: now, order: 3 }
  ];
}
