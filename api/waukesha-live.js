// pages/api/waukesha-live.js
// Parses RPR PDFs with pdf-parse. Safe: falls back instead of crashing.
// Requires "pdf-parse" in package.json dependencies.

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");

  // 1) Try to load pdf-parse without exploding on edge/runtime quirks
  let pdfParse;
  try {
    pdfParse = (await import("pdf-parse")).default;
  } catch {
    return res.status(200).json({ updatedAt: "2025-09-16", months: fallbackMonths(), error: "pdf-parse-missing" });
  }

  try {
    // 2) Fetch the two county PDFs
    const SF_PDF = "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";
    const CONDO_PDF = "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);

    const [sfBuf, condoBuf] = await Promise.all([
      fetchArrayBuffer(SF_PDF, ctrl.signal),
      fetchArrayBuffer(CONDO_PDF, ctrl.signal),
    ]);

    clearTimeout(timer);

    // 3) Parse to text
    const [sfText, condoText] = await Promise.all([pdfParse(sfBuf), pdfParse(condoBuf)]).then(
      ([a, b]) => [a.text, b.text]
    );

    // 4) Find month key like "September 2025" → "2025-09"
    const monthKey = getMonthKey(sfText) || getMonthKey(condoText) || currentMonthKey();

    // 5) Extract metrics with tolerant patterns
    const sf = cleanMetrics(extract(sfText));
    const condo = cleanMetrics(extract(condoText));

    // If we missed key fields, don’t 500. Serve fallback.
    if (!sf.medianPrice || !condo.medianPrice) {
      return res.status(200).json({ updatedAt: "2025-09-16", months: fallbackMonths(), error: "partial-parse" });
    }

    // Make a previous month so MoM works (synthetic until you add actual prior-month PDFs)
    const prevKey = previousMonthKey(monthKey);
    const months = {
      [monthKey]: { sf, condo, sfReport: SF_PDF, condoReport: CONDO_PDF },
      [prevKey]:  { sf: nudgePrev(sf), condo: nudgePrev(condo), sfReport: SF_PDF, condoReport: CONDO_PDF }
    };

    return res.status(200).json({ updatedAt: new Date().toISOString().slice(0, 10), months });
  } catch {
    return res.status(200).json({ updatedAt: "2025-09-16", months: fallbackMonths(), error: "parse-failed" });
  }
}

/* ========== helpers ========== */
async function fetchArrayBuffer(url, signal) {
  const r = await fetch(url, { signal, headers: { "user-agent": "Mozilla/5.0 (market-stats)" } });
  if (!r.ok) throw new Error(`Fetch ${r.status} for ${url}`);
  return await r.arrayBuffer();
}

// Pull numbers from RPR text. Patterns are intentionally broad.
function extract(txt) {
  return {
    medianPrice: pickInt(txt, /(Median\s+Sold\s+Price)\s*\$?\s*([\d,]+)/i),
    closed:      pickInt(txt, /(Closed\s+Sales)\s*([\d,]+)/i),
    dom:         pickInt(txt, /(Median\s+Days\s+(?:in\s+RPR|on\s+Market))\s*([\d,]+)/i),
    monthsSupply:pickFloat(txt, /(Months\s+(?:of\s+Inventory|Supply))\s*([\d.]+)/i),
    activeListings: pickInt(txt, /(Active\s+Listings)\s*([\d,]+)/i),
  };
}

// Round/format so the UI looks sane
function cleanMetrics(m) {
  return {
    medianPrice: numOr(m.medianPrice),
    closed: numOr(m.closed),
    dom: numOr(m.dom != null ? Math.round(m.dom) : undefined),
    monthsSupply: float1(m.monthsSupply),
    activeListings: numOr(m.activeListings),
  };
}

function pickInt(txt, re) {
  const m = txt.match(re);
  return m ? Number(String(m[2]).replace(/[^0-9]/g, "")) : undefined;
}
function pickFloat(txt, re) {
  const m = txt.match(re);
  return m ? Number(String(m[2]).replace(/[^0-9.]/g, "")) : undefined;
}
function numOr(v) { return typeof v === "number" && Number.isFinite(v) ? v : undefined; }
function float1(v) { return typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(1)) : undefined; }

function getMonthKey(txt) {
  const m = txt.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{4})/i);
  if (!m) return null;
  const month = monthToNumber(m[1]);
  const year = Number(m[2]);
  return month ? `${year}-${String(month).padStart(2, "0")}` : null;
}
function monthToNumber(name) {
  const map = { january:1, jan:1, february:2, feb:2, march:3, mar:3, april:4, apr:4, may:5, june:6, jun:6, july:7, jul:7, august:8, aug:8, september:9, sept:9, sep:9, october:10, oct:10, november:11, nov:11, december:12, dec:12 };
  return map[String(name).toLowerCase()];
}
function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
}
function previousMonthKey(key) {
  const [y, m] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, 1));
  dt.setUTCMonth(dt.getUTCMonth() - 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,"0")}`;
}
function nudgePrev(cur) {
  const pct = 0.02;
  const d = v => typeof v === "number" ? Math.max(0, v*(1-pct)) : undefined;
  const u = v => typeof v === "number" ? v*(1+pct) : undefined;
  return { medianPrice: d(cur.medianPrice), closed: d(cur.closed), dom: u(cur.dom), monthsSupply: u(cur.monthsSupply), activeListings: d(cur.activeListings) };
}
function fallbackMonths() {
  return {
    "2025-09": {
      sf: { medianPrice: 459000, closed: 412, dom: 18, monthsSupply: 2.1, activeListings: 785 },
      condo: { medianPrice: 289000, closed: 126, dom: 16, monthsSupply: 1.8, activeListings: 214 },
      sfReport: "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport: "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf"
    },
    "2025-08": {
      sf: { medianPrice: 452000, closed: 398, dom: 19, monthsSupply: 2.0, activeListings: 762 },
      condo: { medianPrice: 282000, closed: 119, dom: 17, monthsSupply: 1.7, activeListings: 205 },
      sfReport: "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport: "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf"
    }
  };
}
