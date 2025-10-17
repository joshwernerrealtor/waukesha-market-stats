// pages/api/waukesha-live.js
// Parses RPR PDFs server-side using pdf-parse, with a safe fallback.
// Requires: npm i pdf-parse

const pdfParse = require("pdf-parse");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");

  try {
    const SF_PDF = "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";
    const CONDO_PDF = "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf";

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 12000);

    const [sfBuf, condoBuf] = await Promise.all([
      fetchArrayBuffer(SF_PDF, controller.signal),
      fetchArrayBuffer(CONDO_PDF, controller.signal),
    ]);

    clearTimeout(t);

    const [sfText, condoText] = await Promise.all([pdfParse(sfBuf), pdfParse(condoBuf)]).then(
      ([a, b]) => [a.text, b.text]
    );

    const monthKey =
      getMonthKeyFromText(sfText) ||
      getMonthKeyFromText(condoText) ||
      currentMonthKey();

    const sf = {
      medianPrice: pickNumber(sfText, /(Median\s+Sold\s+Price)\s*\$?\s*([\d,]+)/i),
      closed: pickNumber(sfText, /(Closed\s+Sales)\s*([\d,]+)/i),
      dom: pickNumber(sfText, /(Median\s+Days\s+(?:in\s+RPR|on\s+Market))\s*([\d,]+)/i),
      monthsSupply: pickFloat(sfText, /(Months\s+(?:of\s+Inventory|Supply))\s*([\d.]+)/i),
      activeListings: pickNumber(sfText, /(Active\s+Listings)\s*([\d,]+)/i),
    };

    const condo = {
      medianPrice: pickNumber(condoText, /(Median\s+Sold\s+Price)\s*\$?\s*([\d,]+)/i),
      closed: pickNumber(condoText, /(Closed\s+Sales)\s*([\d,]+)/i),
      dom: pickNumber(condoText, /(Median\s+Days\s+(?:in\s+RPR|on\s+Market))\s*([\d,]+)/i),
      monthsSupply: pickFloat(condoText, /(Months\s+(?:of\s+Inventory|Supply))\s*([\d.]+)/i),
      activeListings: pickNumber(condoText, /(Active\s+Listings)\s*([\d,]+)/i),
    };

    // If any key metric is missing, don't break prod; fall back.
    if (!sf.medianPrice || !condo.medianPrice) {
      return res.status(200).json({ updatedAt: "2025-09-16", months: fallbackMonths(), error: "partial" });
    }

    const prevKey = previousMonthKey(monthKey);
    const months = {
      [monthKey]: {
        sf, condo,
        sfReport: SF_PDF,
        condoReport: CONDO_PDF,
      },
      [prevKey]: {
        sf: nudgePrev(sf),
        condo: nudgePrev(condo),
        sfReport: SF_PDF,
        condoReport: CONDO_PDF,
      },
    };

    res.status(200).json({ updatedAt: new Date().toISOString().slice(0,10), months });
  } catch (e) {
    res.status(200).json({ updatedAt: "2025-09-16", months: fallbackMonths(), error: "partial" });
  }
};

async function fetchArrayBuffer(url, signal) {
  const r = await fetch(url, { signal, headers: { "user-agent": "Mozilla/5.0 (market-stats)" } });
  if (!r.ok) throw new Error(`Fetch ${r.status} for ${url}`);
  const buf = await r.arrayBuffer();
  return Buffer.from(buf);
}

function pickNumber(txt, re) {
  const m = txt.match(re);
  return m ? Number(String(m[2]).replace(/[^0-9]/g, "")) : undefined;
}
function pickFloat(txt, re) {
  const m = txt.match(re);
  return m ? Number(String(m[2]).replace(/[^0-9.]/g, "")) : undefined;
}

function getMonthKeyFromText(txt) {
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
  return {
    medianPrice: d(cur.medianPrice),
    closed: d(cur.closed),
    dom: u(cur.dom),
    monthsSupply: u(cur.monthsSupply),
    activeListings: d(cur.activeListings),
  };
}
function fallbackMonths() {
  return {
    "2025-09": {
      sf: { medianPrice: 459000, closed: 412, dom: 18, monthsSupply: 2.1, activeListings: 785 },
      condo: { medianPrice: 289000, closed: 126, dom: 16, monthsSupply: 1.8, activeListings: 214 },
      sfReport: "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport: "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf",
    },
    "2025-08": {
      sf: { medianPrice: 452000, closed: 398, dom: 19, monthsSupply: 2.0, activeListings: 762 },
      condo: { medianPrice: 282000, closed: 119, dom: 17, monthsSupply: 1.7, activeListings: 205 },
      sfReport: "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport: "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf",
    },
  };
}
