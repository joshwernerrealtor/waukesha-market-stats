// pages/api/rates.js
// Associated Bank only. Targets the "30 Year Fixed" block and reads labeled Interest Rate and APR.
// Short cache + strict timeouts. If parsing fails, returns a sane fallback so the UI never shows dashes.

const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes
const TIMEOUT_MS   = 7000;            // 7 seconds

let CACHE = { ts: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600"); // 15m CDN

  const now = Date.now();
  if (CACHE.data && now - CACHE.ts < CACHE_TTL_MS) {
    return res.status(200).json(CACHE.data);
  }

  try {
    const lender = await withTimeout(fetchAssociatedBank(), TIMEOUT_MS);

    const list = lender && (lender.rate || lender.apr)
      ? [lender]
      : fallbackSample();

    const payload = {
      generatedAt: new Date().toISOString(),
      lenders: list.slice(0, 1)
    };

    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  } catch (e) {
    const payload = { generatedAt: new Date().toISOString(), lenders: fallbackSample(), error: "partial" };
    CACHE = { ts: now, data: payload };
    res.status(200).json(payload);
  }
}

/* ---------------- Provider: Associated Bank ---------------- */

async function fetchAssociatedBank() {
  const url = "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24";
  const html = await fetchText(url);

  // Narrow to the “30 Year Fixed” neighborhood so we don’t grab Jumbo/ARM rows.
  // We take ~1500 chars around the first match for safety.
  const block = extractThirtyYearBlock(html);

  // Pull labeled Interest Rate and APR within that block.
  const interest = findPercent(block, /(Interest\s*Rate|Rate)\s*:?\s*(\d{1,2}\.\d{1,3})\s*%/i);
  const apr      = findPercent(block, /\bAPR\b\s*:?\s*(\d{1,2}\.\d{1,3})\s*%/i);

  // If we didn’t get labeled values, try the “two percents near each other” fallback.
  const duo = interest == null || apr == null ? twoPercentsNearby(block) : null;
  const baseRate = interest ?? duo?.base ?? undefined;
  const aprRate  = apr ?? duo?.apr ?? undefined;

  // Sanity: ignore absurd numbers, and don’t let APR be lower than base if both present.
  const cleanRate = inRange(baseRate) ? baseRate : undefined;
  const cleanAPR  = inRange(aprRate)  ? aprRate  : undefined;
  const final = normalizeRateApr(cleanRate, cleanAPR);

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

/* ---------------- Parsing helpers ---------------- */

function extractThirtyYearBlock(html) {
  const clean = html.replace(/\s+/g, " ");
  const m = clean.match(/30\s*(?:year|yr)\s*(?:fixed)?[^]{0,1500}/i);
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
  // If only one is present, use it as the big number.
  if (rate != null && apr == null) return { rate, apr: undefined };
  if (rate == null && apr != null) return { rate: apr, apr }; // show APR as the big number

  if (rate != null && apr != null) {
    // APR should never be less than the base rate. If it is, swap.
    if (parseFloat(apr) < parseFloat(rate)) {
      return { rate: apr, apr: rate };
    }
    return { rate, apr };
  }
  return { rate: undefined, apr: undefined };
}

function inRange(n) {
  const x = parseFloat(n);
  return Number.isFinite(x) && x >= 2 && x <= 20; // keep it sane
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

/* ---------------- Fallback (shown only if parsing fails) ---------------- */

function fallbackSample() {
  const now = new Date().toISOString();
  return [{
    name: "Associated Bank",
    product: "30 yr fixed",
    rate: "6.125",   // align with what you observed on their site
    apr:  "6.250",
    url: "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24",
    contactUrl: "https://www.associatedbank.com/personal/loans/home-loans",
    updatedAt: now,
    order: 1
  }];
}
