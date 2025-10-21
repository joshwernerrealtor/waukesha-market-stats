// pages/api/waukesha-live.js
// Auto-extracts Waukesha County stats from RPR PDFs (SF + Condo) with debug mode.
// Pulls: Median Price, Closed Sales, Days on Market, Months of Inventory/Supply, Active Listings.
// Sets updatedAt from Last-Modified. Cache: 5 min. Requires "pdf-parse" in package.json.

import pdfParse from "pdf-parse";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");

  const debug = String(req.query.debug || "") === "1";

  // Update these only if RPR rotates the IDs
  const SF_URL    = "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";
  const CONDO_URL = "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf";

  try {
    // 1) Last-Modified headers → updatedAt
    const [sfHead, condoHead] = await Promise.all([headOrByte(SF_URL), headOrByte(CONDO_URL)]);
    const lmDates = [sfHead.lastModified, condoHead.lastModified].filter(Boolean);
    let updatedAt = null;
    if (lmDates.length) {
      const newest = new Date(Math.max(...lmDates.map(d => d.getTime())));
      updatedAt = ymd(new Date(newest));
    }
    if (!updatedAt && process.env.WAU_UPDATED_AT && /^\d{4}-\d{2}-\d{2}$/.test(process.env.WAU_UPDATED_AT)) {
      updatedAt = process.env.WAU_UPDATED_AT;
    }

    // 2) Parse both PDFs
    const [sfText, condoText] = await Promise.all([fetchPdfText(SF_URL), fetchPdfText(CONDO_URL)]);

    const monthLabel = detectMonth(sfText) || detectMonth(condoText) || fallbackMonth();
    const key = monthKeyFromLabel(monthLabel); // "YYYY-MM"

    const sfParse   = parseRprStats(sfText, { collectMatches: debug });
    const condoParse= parseRprStats(condoText, { collectMatches: debug });

    const months = {
      [key]: {
        sf: pruneTo5(sfParse.values),
        condo: pruneTo5(condoParse.values),
        sfReport: SF_URL,
        condoReport: CONDO_URL
      }
    };

    // 3) If no header date, fall back to first day of label month
    if (!updatedAt) {
      const [yy, mm] = key.split("-").map(Number);
      updatedAt = ymd(new Date(yy, mm - 1, 1));
    }

    const payload = { updatedAt, months };

    if (debug) {
      payload.__debug = {
        monthLabel,
        key,
        sf: {
          matches: sfParse.matches.slice(0, 30), // keep it readable
          sample: sfText.split("\n").slice(0, 60) // top of doc
        },
        condo: {
          matches: condoParse.matches.slice(0, 30),
          sample: condoText.split("\n").slice(0, 60)
        },
        headers: {
          sfLastModified: sfHead.lastModified?.toISOString() || null,
          condoLastModified: condoHead.lastModified?.toISOString() || null
        }
      };
    }

    res.status(200).json(payload);
  } catch (err) {
    // Return a safe shape so the UI keeps working
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}`;
    const months = {
      [key]: {
        sf: emptyStats(),
        condo: emptyStats(),
        sfReport: "https://www.narrpr.com/",
        condoReport: "https://www.narrpr.com/"
      }
    };
    res.status(200).json({ updatedAt: ymd(today), months, error: String(err) });
  }
}

/* ================= helpers ================= */

function emptyStats(){
  return { medianPrice: null, closed: null, dom: null, monthsSupply: null, activeListings: null };
}
function pruneTo5(v){
  // ensures only the 5 fields your UI expects
  return {
    medianPrice: v.medianPrice ?? null,
    closed: v.closed ?? null,
    dom: v.dom ?? null,
    monthsSupply: v.monthsSupply ?? null,
    activeListings: v.activeListings ?? null
  };
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
  return (parsed.text || "")
    .replace(/\r/g,"")
    .replace(/[ \t]+/g," ")
    .replace(/\n{2,}/g,"\n");
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
  const d = new Date();
  d.setMonth(d.getMonth()-1, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function fallbackMonthKey(){
  const d = new Date();
  d.setMonth(d.getMonth()-1, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}
function ymd(d){
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,"0");
  const day = String(d.getUTCDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function titleCase(s){ return s.replace(/\w\S*/g, t => t[0].toUpperCase()+t.slice(1).toLowerCase()); }

/* ====== Parser with line-window + synonyms + optional debug matches ====== */
function parseRprStats(txt, opts = {}){
  if (!txt) return { values: emptyStats(), matches: [] };

  const collect = opts.collectMatches === true;
  const lines = txt.split(/\n/).map(s => s.trim()).filter(Boolean);
  const matches = [];

  const firstInt   = s => { const m = String(s||"").match(/-?\d{1,3}(?:,\d{3})*|\d+/); return m ? parseInt(m[0].replace(/,/g,""),10) : null; };
  const firstFloat = s => { const m = String(s||"").match(/-?\d+(?:\.\d+)?/);         return m ? parseFloat(m[0]) : null; };

  function pickNumberAround(idx, asFloat = false, lookAhead = 3){
    for (let i = idx; i <= Math.min(idx + lookAhead, lines.length - 1); i++){
      const n = asFloat ? firstFloat(lines[i]) : firstInt(lines[i]);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  const out = { medianPrice: null, closed: null, dom: null, monthsSupply: null, activeListings: null };

  for (let i = 0; i < lines.length; i++){
    const line = lines[i];

    if (/(^|\s)median\s+(sold\s+)?price(\s|$)/i.test(line)) {
      const raw = firstInt(line) ?? pickNumberAround(i+1, false, 2);
      if (collect) matches.push({ metric: "medianPrice", line, raw });
      if (isNum(raw)) out.medianPrice = raw;
      continue;
    }
    if (/(^|\s)(closed\s+sales|sold\s+listings|closed\s+listings)(\s|$)/i.test(line)) {
      const raw = firstInt(line) ?? pickNumberAround(i+1, false, 3);
      if (collect) matches.push({ metric: "closed", line, raw });
      if (isNum(raw)) out.closed = raw;
      continue;
    }
    if (/(^|\s)(median\s+days\s+(in\s+rpr|on\s+market)|days\s+on\s+market)(\s|$)/i.test(line)) {
      const raw = firstInt(line) ?? pickNumberAround(i+1, false, 2);
      if (collect) matches.push({ metric: "dom", line, raw });
      if (isNum(raw)) out.dom = raw;
      continue;
    }
    if (/(^|\s)(months\s+of\s+inventory|months\s+(of\s+)?supply)(\s|$)/i.test(line)) {
      const raw = firstFloat(line) ?? pickNumberAround(i+1, true, 2);
      if (collect) matches.push({ metric: "monthsSupply", line, raw });
      if (isNum(raw)) out.monthsSupply = round1(raw);
      continue;
    }
    if (/(^|\s)(active\s+listings|active\s+inventory|inventory\s+of\s+homes\s+for\s+sale|active\s+residential\s+listings|active\s+listings.*month\s+end)(\s|$)/i.test(line)) {
      const raw = firstInt(line) ?? pickNumberAround(i+1, false, 3);
      if (collect) matches.push({ metric: "activeListings", line, raw });
      if (isNum(raw)) out.activeListings = raw;
      continue;
    }
  }

  return { values: out, matches };
}

function isNum(n){ return typeof n === "number" && Number.isFinite(n); }
function round1(n){ return Math.round(n*10)/10; }
