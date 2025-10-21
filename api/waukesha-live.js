// pages/api/waukesha-live.js
// Auto-extracts Waukesha County stats from the two official RPR PDFs.
// Pulls: Median Price, Closed Sales, Days on Market, Months of Inventory/Supply, Active Listings.
// Sets updatedAt from the PDFs' Last-Modified header. Caches 5 min at the edge.
// Requires "pdf-parse" in package.json. Do NOT run this route on the Edge runtime.

import pdfParse from "pdf-parse";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");

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

    const sfStats    = parseRprStats(sfText);
    const condoStats = parseRprStats(condoText);

    const months = {
      [key]: {
        sf: sfStats,
        condo: condoStats,
        sfReport: SF_URL,
        condoReport: CONDO_URL
      }
    };

    // 3) If no header date, fall back to first day of label month
    if (!updatedAt) {
      const [yy, mm] = key.split("-").map(Number);
      updatedAt = ymd(new Date(yy, mm - 1, 1));
    }

    res.status(200).json({ updatedAt, months });
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

async function headOrByte(url){
  // HEAD for headers; if blocked, GET first byte (still gives headers)
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
    .replace(/[ \t]+/g," ")   // collapse spaces
    .replace(/\n{2,}/g,"\n"); // soften line breaks
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

/* ====== Smarter parser: tolerates label synonyms and values on next lines ======
Typical lines in RPR PDFs:
  Median Sold Price $520,000
  Closed Sales 312
  Median Days in RPR 48
  Months of Inventory 1.5
  Active Listings 402

RPR loves putting the number on the next line or renaming labels, so we scan a small window.
*/
function parseRprStats(txt){
  if (!txt) return emptyStats();

  const lines = txt.split(/\n/).map(s => s.trim()).filter(Boolean);

  // Find first integer/float in a string
  const firstInt   = s => { const m = String(s||"").match(/-?\d{1,3}(?:,\d{3})*|\d+/); return m ? parseInt(m[0].replace(/,/g,""),10) : null; };
  const firstFloat = s => { const m = String(s||"").match(/-?\d+(?:\.\d+)?/);         return m ? parseFloat(m[0]) : null; };

  // Scan forward a few lines to grab a number after a matched label
  function pickNumberAround(idx, asFloat = false, lookAhead = 3){
    for (let i = idx; i <= Math.min(idx + lookAhead, lines.length - 1); i++){
      const n = asFloat ? firstFloat(lines[i]) : firstInt(lines[i]);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  const out = {
    medianPrice: null,
    closed: null,
    dom: null,
    monthsSupply: null,
    activeListings: null
  };

  for (let i = 0; i < lines.length; i++){
    const line = lines[i];

    // Median price
    if (/(^|\s)median\s+(sold\s+)?price(\s|$)/i.test(line)) {
      const raw = firstInt(line) ?? pickNumberAround(i+1, false, 2);
      if (isNum(raw)) out.medianPrice = raw;
      continue;
    }
    // Closed sales (aka sold listings)
    if (/(^|\s)(closed\s+sales|sold\s+listings|closed\s+listings)(\s|$)/i.test(line)) {
      const raw = firstInt(line) ?? pickNumberAround(i+1, false, 3);
      if (isNum(raw)) out.closed = raw;
      continue;
    }
    // Days on market (aka Median Days in RPR)
    if (/(^|\s)(median\s+days\s+(in\s+rpr|on\s+market)|days\s+on\s+market)(\s|$)/i.test(line)) {
      const raw = firstInt(line) ?? pickNumberAround(i+1, false, 2);
      if (isNum(raw)) out.dom = raw;
      continue;
    }
    // Months supply / inventory
    if (/(^|\s)(months\s+of\s+inventory|months\s+(of\s+)?supply)(\s|$)/i.test(line)) {
      const raw = firstFloat(line) ?? pickNumberAround(i+1, true, 2);
      if (isNum(raw)) out.monthsSupply = round1(raw);
      continue;
    }
    // Active listings (aka active inventory)
    if (/(^|\s)(active\s+listings|active\s+inventory|inventory\s+of\s+homes\s+for\s+sale|active\s+residential\s+listings|active\s+listings.*month\s+end)(\s|$)/i.test(line)) {
      const raw = firstInt(line) ?? pickNumberAround(i+1, false, 3);
      if (isNum(raw)) out.activeListings = raw;
      continue;
    }
  }

  return out;
}

function isNum(n){ return typeof n === "number" && Number.isFinite(n); }
function round1(n){ return Math.round(n*10)/10; }
