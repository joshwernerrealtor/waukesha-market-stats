// pages/api/waukesha-live.js
// Extract Waukesha County stats from two RPR PDFs (SF + Condo)
// and MERGE with your existing stub (/api/waukesha) so the Month
// dropdown keeps prior months while the newest month rolls in.
// Cache: 5 min. Requires pdf-parse. Not Edge.

import pdfParse from "pdf-parse";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");

  const SF_URL    = "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";
  const CONDO_URL = "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf";

  try {
    // updatedAt from Last-Modified header if present
    const [sfHead, condoHead] = await Promise.all([headOrByte(SF_URL), headOrByte(CONDO_URL)]);
    const lmDates = [sfHead.lastModified, condoHead.lastModified].filter(Boolean);
    let updatedAt = lmDates.length ? ymd(new Date(Math.max(...lmDates.map(d => d.getTime())))) : null;

    // Pull text from PDFs
    const [sfText, condoText] = await Promise.all([fetchPdfText(SF_URL), fetchPdfText(CONDO_URL)]);

    // Month detection
    const monthLabel = detectMonth(sfText) || detectMonth(condoText) || fallbackMonth();
    const key = monthKeyFromLabel(monthLabel);

    // Parse metrics
    const sfStats    = parseRprStats(sfText);
    const condoStats = parseRprStats(condoText);

    // Merge with existing stub so dropdown keeps older months
    const origin  = getOrigin(req) || "http://localhost:3000";
    const stubUrl = new URL("/api/waukesha?ts=" + Date.now(), origin).toString();
    const existing = await fetch(stubUrl, { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null);

    let months = {};
    if (existing?.months && typeof existing.months === "object") months = { ...existing.months };

    months[key] = {
      sf: sfStats,
      condo: condoStats,
      sfReport: SF_URL,
      condoReport: CONDO_URL
    };

    // Keep latest 6 months only
    const trimmed = Object.keys(months).sort().reverse().slice(0, 6)
      .reduce((acc, k) => (acc[k] = months[k], acc), {});

    if (!updatedAt) {
      const [yy, mm] = key.split("-").map(Number);
      updatedAt = ymd(new Date(yy, mm - 1, 1));
    }

    res.status(200).json({ updatedAt, months: trimmed });
  } catch (err) {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}`;
    res.status(200).json({
      updatedAt: ymd(today),
      months: { [key]: { sf: emptyStats(), condo: emptyStats(), sfReport: SF_URL, condoReport: CONDO_URL } },
      error: String(err)
    });
  }
}

/* ============== helpers ============== */
function emptyStats(){
  return { medianPrice: null, closed: null, dom: null, monthsSupply: null, activeListings: null };
}
function getOrigin(req){
  const proto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0] || "https";
  const host  = req.headers.host || "";
  return host ? `${proto}://${host}` : null;
}
async function headOrByte(url){
  let r = await fetch(url, { method: "HEAD" }).catch(() => null);
  if (!r || !r.ok) r = await fetch(url, { method: "GET", headers: { range:"bytes=0-0" } }).catch(() => null);
  const lm = r?.headers?.get("last-modified") || r?.headers?.get("Last-Modified");
  return { lastModified: lm ? new Date(lm) : null };
}
async function fetchPdfText(url){
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`PDF fetch failed ${r.status} for ${url}`);
  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab);
  const parsed = await pdfParse(buf);
  return (parsed.text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n");
}
function detectMonth(txt){
  const months = "(January|February|March|April|May|June|July|August|September|October|November|December)";
  const re = new RegExp(`${months}\\s+20\\d{2}`, "i");
  const m = txt.match(re);
  return m ? titleCase(m[0]) : null;
}
function monthKeyFromLabel(label){
  if (!label) return fallbackMonthKey();
  const [mon, year] = label.split(/\s+/);
  const map = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
  const mm = map[mon.toLowerCase()] || (new Date(label).getMonth()+1);
  const yy = parseInt(year,10);
  return `${yy}-${String(mm).padStart(2,"0")}`;
}
function fallbackMonth(){
  const d = new Date(); d.setMonth(d.getMonth()-1, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function fallbackMonthKey(){
  const d = new Date(); d.setMonth(d.getMonth()-1, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}
function ymd(d){
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,"0");
  const day = String(d.getUTCDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function titleCase(s){ return s.replace(/\w\S*/g, t => t[0].toUpperCase()+t.slice(1).toLowerCase()); }

// Parser (same logic you had)
function parseRprStats(txt){
  if (!txt) return emptyStats();
  const lines = txt split(/\n/).map(s => s.trim()).filter(Boolean);
  const firstInt   = s => { const m = String(s||"").match(/-?\d{1,3}(?:,\d{3})*|\d+/); return m ? parseInt(m[0].replace(/,/g,""),10) : null; };
  const firstFloat = s => { const m = String(s||"").match(/-?\d+(?:\.\d+)?/);         return m ? parseFloat(m[0]) : null; };
  const pctOrMoM   = /%|MoM/i;
  function pickNumberAround(idx, asFloat = false, lookAhead = 3){
    for (let i = idx; i <= Math.min(idx + lookAhead, lines.length - 1); i++){
      const ln = lines[i];
      if (pctOrMoM.test(ln)) continue;
      const n = asFloat ? firstFloat(ln) : firstInt(ln);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }
  const monthRegex = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i;
  const yearRegex  = /\b20\d{2}\b/;
  const sane = {
    price(n, line) {
      if (!Number.isFinite(n)) return null;
      if (/\$|price/i.test(line)) return (n >= 20000 && n <= 2000000) ? n : null;
      return (n >= 20000 && n <= 2000000) ? n : null;
    },
    closed(n) { return Number.isFinite(n) && n >= 0 && n < 10000 ? n : null; },
    dom(n)    { return Number.isFinite(n) && n >= 0 && n <= 365 ? n : null; },
    mois(n)   { return Number.isFinite(n) && n >= 0 && n < 50 ? Math.round(n*10)/10 : null; },
    active(n, line) {
      if (!Number.isFinite(n)) return null;
      if (/\$|price/i.test(line)) return null;
      return (n >= 0 && n < 50000) ? n : null;
    }
  };
  const reMedianPrice = /(median\s+(sold\s+)?price)/i;
  const reDom         = /(median\s+days\s+(in\s+rpr|on\s+market)|days\s+on\s+market)/i;
  const reMonths      = /(months\s+of\s+inventory|months\s+(of\s+)?supply)/i;
  const reClosedAny   = /(closed\s+sales|sold\s+listings|total\s+sales|closed\s+listings)/i;
  const junkClosed    = /(median|price|active|inventory|months|supply|list\s*price|sold\s*to\s*list)/i;
  const reActiveLabel = /(^|\s)active\s+(listings|residential\s+listings)(\s|$)/i;
  const junkActive    = /(sold|sales|median|price|list\s*price)/i;
  const out = { medianPrice: null, closed: null, dom: null, monthsSupply: null, activeListings: null };
  for (let i = 0; i < lines.length; i++){
    const line = lines[i];
    if (out.medianPrice == null && reMedianPrice.test(line)) {
      const candidate = firstInt(line) ?? pickNumberAround(i+1, false, 2);
      const val = sane.price(candidate, line);
      if (val != null) out.medianPrice = val; continue;
    }
    if (out.closed == null && reClosedAny.test(line)) {
      if (monthRegex.test(line) || yearRegex test(line) || junkClosed.test(line)) {
        const val = findForward(lines, i+1, 10, (ln) => {
          if (monthRegex.test(ln) || yearRegex.test(ln) || junkClosed.test(ln) || pctOrMoM.test(ln)) return null;
          return sane.closed(firstInt(ln));
        });
        if (val != null) { out.closed = val; continue; }
      } else {
        const candidate = firstInt(line) ?? pickNumberAround(i+1, false, 4);
        const val = sane.closed(candidate);
        if (val != null) { out.closed = val; continue; }
        const val2 = findForward(lines, i+1, 10, (ln) => {
          if (monthRegex.test(ln) || yearRegex.test(ln) || junkClosed test(ln) || pctOrMoM.test(ln)) return null;
          return sane.closed(firstInt(ln));
        });
        if (val2 != null) { out.closed = val2; continue; }
      }
    }
    if (out.dom == null && reDom test(line)) {
      const candidate = firstInt(line) ?? pickNumberAround(i+1, false, 2);
      const val = sane.dom(candidate);
      if (val != null) out.dom = val; continue;
    }
    if (out.monthsSupply == null && reMonths test(line)) {
      const candidate = (yearRegex test(line) || monthRegex test(line)) ? pickNumberAround(i+1, true, 2) : (firstFloat(line) ?? pickNumberAround(i+1, true, 2));
      const val = sane.mois(candidate);
      if (val != null) out.monthsSupply = val; continue;
    }
    if (out.activeListings == null && reActiveLabel test(line)) {
      let val = null;
      if (yearRegex test(line) || monthRegex test(line) || junkActive test(line)) {
        val = findForward(lines, i+1, 8, (ln) => {
          if (monthRegex test(ln) || yearRegex test(ln) || junkActive test(ln) || pctOrMoM test(ln)) return null;
          const cand = sane.active(firstInt(ln), ln);
          if (cand != null && (out.closed == null || cand !== out.closed)) return cand;
          return null;
        });
      } else {
        const cand = sane.active(firstInt(line) ?? pickNumberAround(i+1, false, 3), line);
        if (cand != null && (out.closed == null || cand !== out.closed)) {
          val = cand;
        } else {
          val = findForward(lines, i+1, 8, (ln) => {
            if (monthRegex test(ln) || yearRegex test(ln) || junkActive test(ln) || pctOrMoM test(ln)) return null;
            const c = sane.active(firstInt(ln), ln);
            if (c != null && (out.closed == null || c !== out.closed)) return c;
            return null;
          });
        }
      }
      if (val != null) out.activeListings = val; continue;
    }
  }
  return out;
  function findForward(arr, start, maxAhead, pick){
    for (let j = start; j <= Math.min(start + maxAhead, arr.length - 1); j++){
      const v = pick(arr[j]);
      if (v != null) return v;
    }
    return null;
  }
}
