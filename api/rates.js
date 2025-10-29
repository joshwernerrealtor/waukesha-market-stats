// pages/api/rates.js
// Policy: only return live, correctly parsed lenders. No stale fallbacks.
// Lender toggles (comma-separated): LENDER_WHITELIST="summit,uwcu,ab"
// Optional manual overrides (only if you want them): AB_RATE, AB_APR, UWCU_RATE, UWCU_APR, SUMMIT_RATE, SUMMIT_APR
// Debug: /api/rates?debug=all|ab|uwcu|summit   Force fresh: ?force=1

const TIMEOUT_MS = 8000;
function getWhitelist(req) {
  try {
    const u = new URL(req.url, "http://localhost");
    const qp = (u.searchParams.get("allow") || "").trim();
    if (qp) return qp.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

    const env = (process.env.LENDER_WHITELIST || "").trim();
    if (env) return env.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

    // Safe default so you never get [] again
    return ["summit", "uwcu"];
  } catch {
    return ["summit", "uwcu"];
  }
}

export default async function handler(req, res) {
  const url   = new URL(req.url, "http://localhost");
  const debug = url.searchParams.get("debug");
  const force = url.searchParams.get("force") === "1";

  // Cache less aggressively at the edge. Force = no-store.
  res.setHeader("Cache-Control", force ? "no-store" : "s-maxage=300, stale-while-revalidate=1800");

  // Which lenders are allowed
  const whitelist = (process.env.LENDER_WHITELIST || "summit,uwcu").split(",").map(s => s.trim().toLowerCase());

  // Kick off fetches based on whitelist
  const tasks = [];
  if (whitelist.includes("summit")) tasks.push(named("summit", fetchSummitJSON({ debug: debug === "summit" || debug === "all" })));
  if (whitelist.includes("uwcu"))   tasks.push(named("uwcu",   fetchUWCU({ debug: debug === "uwcu"   || debug === "all" })));
  if (whitelist.includes("ab"))     tasks.push(named("ab",     fetchAssociatedBank({ debug: debug === "ab"     || debug === "all" })));

  const results = await Promise.allSettled(tasks.map(t => withTimeout(t.run, TIMEOUT_MS)));

  // Debug passthroughs
  if (debug === "all") {
    const dbg = {};
    results.forEach((r, i) => {
      const id = tasks[i].id;
      dbg[id] = r.status === "fulfilled" && r.value && r.value.__debug ? r.value.__debug : null;
    });
    return res.status(200).json(dbg);
  } else if (["ab","uwcu","summit"].includes(debug)) {
    const idx = tasks.findIndex(t => t.id === debug);
    const r   = results[idx];
    const out = r?.status === "fulfilled" && r.value && r.value.__debug ? r.value.__debug : null;
    return res.status(200).json(out ?? { note: "no debug payload" });
  }

  // Only include lenders that returned a valid rate or APR
  const lenders = results
    .map((r, i) => (r.status === "fulfilled" ? r.value : null))
    .filter(Boolean)
    .filter(x => x && (isFiniteNum(x.rate) || isFiniteNum(x.apr)))  // only real data
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  return res.status(200).json({
    generatedAt: new Date().toISOString(),
    lenders
  });
}

/* ---------------------- LENDERS ---------------------- */

// Summit: official JSON
async function fetchSummitJSON({ debug = false } = {}) {
  const baseUrl = "https://ratescentral.summitcreditunion.com/api/website/3Uw4xUFQt1EVCMpYRJuXKx/index.json";
  const json = await tryFetchJSON([`${baseUrl}?ts=${Date.now()}`, baseUrl], {
    headers: { accept: "application/json", referer: "https://www.summitcreditunion.com/", "user-agent": "Mozilla/5.0 ratesbot" },
    cache: "no-store"
  });

  const picked = json ? pickSummitThirtyFixed(json) : null;

  let rate = toNum(picked?.rate);
  let apr  = toNum(picked?.apr);

  // optional env overrides
  rate = pick(rate, toNum(process.env.SUMMIT_RATE));
  apr  = pick(apr,  toNum(process.env.SUMMIT_APR));

  const final = normalizeRateApr(rate, apr);
  const payload = base("Summit Credit Union",
    "https://www.summitcreditunion.com/borrow/mortgage-loan/#mortgage-rates", 3, final.rate, final.apr);

  if (debug) payload.__debug = { lender: "Summit", selected: picked, final };
  return payload;
}

// UWCU: robust HTML parse
async function fetchUWCU({ debug = false } = {}) {
  const url = "https://www.uwcu.org/mortgage-home-loans/options/fixed-rate";
  const html = await fetchText(url);
  const clean = html.replace(/\s+/g, " ");
  const match = clean.match(/30[-\s]?Year\s+Fixed\s+Rate\s+Purchase[^]{0,1500}/i);
  const block = match ? match[0] : clean.slice(0, 1500);

  const nums = [];
  const reNum = /rate_number">\s*([0-9]{1,2}\.[0-9]{1,3})\s*</gi;
  let m; while ((m = reNum.exec(block)) && nums.length < 3) { const n = parseFloat(m[1]); if (Number.isFinite(n)) nums.push(n); }

  let rate = nums[0];
  let apr  = nums[1];

  // fallback labels
  if (!isFiniteNum(rate) || !isFiniteNum(apr)) {
    rate = pick(rate, findPercent(block, /Rate[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})%/i));
    apr  = pick(apr,  findPercent(block, /\bAPR\b[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})%/i));
  }

  // optional env overrides
  rate = pick(rate, toNum(process.env.UWCU_RATE));
  apr  = pick(apr,  toNum(process.env.UWCU_APR));

  const final = normalizeRateApr(rate, apr);
  const payload = base("UW Credit Union", url, 2, final.rate, final.apr);

  if (debug) payload.__debug = { lender: "UWCU", snippet: block.slice(0, 800), nums, final };
  return payload;
}

// Associated Bank: disabled by default. Only enable if you add "ab" to LENDER_WHITELIST.
async function fetchAssociatedBank({ debug = false } = {}) {
  // If you insist, enable via LENDER_WHITELIST and optionally provide env overrides.
  const url = "https://www.associatedbank.com/personal/loans/home-loans/mortgage-rates?redir=A24";
  const envRate = toNum(process.env.AB_RATE);
  const envApr  = toNum(process.env.AB_APR);

  // Without overrides we attempt a tolerant parse, but if it fails we return nothing.
  let rate = envRate ?? null;
  let apr  = envApr ?? null;

  if (rate == null || apr == null) {
    const html  = await fetchText(url);
    const block = extractThirtyYearBlock(html);

    const interest = findPercent(block, /(Interest|Note)?\s*Rate[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})%/i)
                  ?? findPercent(block, /\bRate\b[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})%/i)
                  ?? attrPercent(block, /data-rate\s*=\s*"([0-9]{1,2}\.[0-9]{1,3})%"/i);

    const aprCap  = findPercent(block, /\bAPR\b[^0-9]{0,20}([0-9]{1,2}\.[0-9]{1,3})%/i)
                  ?? attrPercent(block, /data-apr\s*=\s*"([0-9]{1,2}\.[0-9]{1,3})%"/i);

    const duo     = (!isFiniteNum(interest) || !isFiniteNum(aprCap)) ? twoPercentsNearby(block) : null;

    rate = pick(rate, interest, duo?.base);
    apr  = pick(apr,  aprCap,   duo?.apr);
  }

  // If still nothing solid, bail out silently. No lying, no stale “fallbacks.”
  if (!isFiniteNum(rate) && !isFiniteNum(apr)) {
    if (debug) return { __debug: { lender: "AB", note: "parse failed; no output" } };
    return null;
  }

  const final = normalizeRateApr(rate, apr);
  const payload = base("Associated Bank", url, 1, final.rate, final.apr);
  if (debug) payload.__debug = { lender: "AB", final };
  return payload;
}

/* ---------------------- SUMMIT PICKER ---------------------- */
function pickSummitThirtyFixed(json) {
  const blocks = [];
  walk(json, n => {
    if (n && typeof n === "object" && Array.isArray(n.fields) && n.fields.length) blocks.push(n);
  });

  for (const b of blocks) {
    const fields = b.fields || [];
    const term   = fields.find(f => /type.*term|term|product|loan/i.test(String(f.title)));
    if (!term) continue;
    const entry  = (term.values || []).find(v => /\b30\b/i.test(String(v?.value)) && /fix/i.test(String(v?.value)));
    if (!entry?.rateId) continue;

    const rid    = entry.rateId;
    const rateF  = fields.find(f => /^rate(s)?$/i.test(String(f.title)));
    const aprF   = fields.find(f => /\bapr\b|annual\s*percentage/i.test(String(f.title)));
    const rate   = rateF?.values?.find(v => v?.rateId === rid)?.value;
    const apr    = aprF?.values?.find(v => v?.rateId === rid)?.value;

    const rNum = toNum(rate);
    const aNum = toNum(apr);
    if (isFiniteNum(rNum) || isFiniteNum(aNum)) return { rate: rNum, apr: aNum, raw: { rid, rate, apr } };
  }

  return null;
}

/* ---------------------- UTILITIES ---------------------- */

function base(name, url, order, rate, apr) {
  return {
    name,
    product: "30 yr fixed",
    rate: rate != null ? round3(rate) : undefined,
    apr:  apr  != null ? round3(apr)  : undefined,
    url,
    contactUrl: url,
    updatedAt: new Date().toISOString(),
    order
  };
}

function isFiniteNum(n){ return Number.isFinite(n); }
function toNum(x){ if (x == null) return null; const n = parseFloat(String(x).replace(/[^\d.]/g,"")); return Number.isFinite(n) ? n : null; }
function round3(n){ return parseFloat(Number(n).toFixed(3)); }
function pick(...v){ return v.find(x => x != null && Number.isFinite(+x)); }

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { cache: "no-store", headers: { "user-agent": "Mozilla/5.0 ratesbot" }, ...opts });
  if (!res.ok) throw new Error(`Bad response ${res.status} for ${url}`);
  return res.text();
}
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { cache: "no-store", ...opts });
  if (!res.ok) throw new Error(`Bad JSON ${res.status} for ${url}`);
  return res.json();
}
async function tryFetchJSON(urls, opts) {
  let lastErr = null;
  for (const u of urls) {
    try { return await fetchJSON(u, opts); } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
}

function extractThirtyYearBlock(html){
  const clean = html.replace(/\s+/g," ");
  const m = clean.match(/30\s*(?:year|yr)\s*(?:fixed)?[^]{0,2000}/i) || clean.match(/fixed[^]{0,2000}30\s*(?:year|yr)/i);
  return m ? m[0] : clean.slice(0, 2000);
}
function findPercent(txt, re){ const m = txt.match(re); if (!m) return null; const raw = m[2] ?? m[1]; const n = parseFloat(raw); return Number.isFinite(n) ? n : null; }
function attrPercent(txt, re){ const m = txt.match(re); if (!m) return null; const n = parseFloat(m[1]); return Number.isFinite(n) ? n : null; }
function twoPercentsNearby(txt){
  const m = txt.match(/([0-9]{1,2}\.[0-9]{1,3})\s*%[^%]{0,140}?(?:APR|A\.?P\.?R\.?)\s*([0-9]{1,2}\.[0-9]{1,3})\s*%/i)
        || txt.match(/(?:APR|A\.?P\.?R\.?)\s*([0-9]{1,2}\.[0-9]{1,3})\s*%[^%]{0,140}?([0-9]{1,2}\.[0-9]{1,3})\s*%/i);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const base = Math.min(a,b), apr = Math.max(a,b);
  return { base, apr };
}
function walk(o, fn){ if (!o || typeof o !== "object") return; fn(o); if (Array.isArray(o)) { for (const v of o) walk(v, fn); return; } for (const v of Object.values(o)) walk(v, fn); }
function named(id, run){ return { id, run }; }
async function withTimeout(p, ms){ return await Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")), ms))]); }
