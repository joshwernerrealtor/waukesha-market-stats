// pages/api/rates.js
// Lenders: Associated Bank + UW Credit Union + Summit Credit Union (JSON).
// Debug URLs: /api/rates?debug=ab | uwcu | summit | all
// Env overrides (optional): AB_RATE, AB_APR, UWCU_RATE, UWCU_APR, SUMMIT_RATE, SUMMIT_APR

const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes
const TIMEOUT_MS   = 7000;
const MAX_LENDERS  = 3;

let CACHE = { ts: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  const url = new URL(req.url, "http://localhost");
  const debug = url.searchParams.get("debug"); // ab | uwcu | summit | all | null

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

// ---------- Associated Bank (HTML) ----------
async function fetchAssociatedBank({ debug = false } = {}) {
  // Optional env override
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
  // Optional env override
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
  const hasOverride = inRange(envRate) || inRange(envApr);

  const baseUrl = "https://ratescentral.summitcreditunion.com/api/website/3Uw4xUFQt1EVCMpYRJuXKx/index.json";

  let json = null, usedUrl = null, error = null;
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
      error = e;
    }
  }

  if (!json && !hasOverride) {
    if (debug) return { __debug: { lender: "Summit", note: "JSON fetch failed; no override", error: String(error) } };
    return null;
  }

  // Pick 30 Year Fixed using rateId joins
  const pickObj = json ? pickSummitThirtyFixed(json) : null;

  let rateNum = toNum(pickObj?.rate);
  let aprNum  = toNum(pickObj?.apr);

  if ((!inRange(rateNum) && hasOverride) || (!inRange(aprNum) && hasOverride)) {
    rateNum = inRange(rateNum) ? rateNum : envRate;
    aprNum  = inRange(aprNum)  ? aprNum  : envApr;
  }

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
  if (!Number.isFinite(a
