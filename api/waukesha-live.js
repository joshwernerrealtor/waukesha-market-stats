// api/waukesha-live.js
// Extract Waukesha County stats from two RPR PDFs (SF + Condo).
// Returns ONLY the newest detected month (no stub merge).
// Cache: 5 min at the edge. Requires pdf-parse.

const pdfParse = require("pdf-parse");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");

  const SF_URL =
    "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";
  const CONDO_URL =
    "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf";

  try {
    // updatedAt from Last-Modified headers if present
    const [sfHead, condoHead] = await Promise.all([
      headOrByte(SF_URL),
      headOrByte(CONDO_URL),
    ]);
    const lmDates = [sfHead.lastModified, condoHead.lastModified].filter(Boolean);
    const updatedAt = lmDates.length
      ? ymd(new Date(Math.max(...lmDates.map((d) => d.getTime()))))
      : ymd(new Date());

    // Pull text from PDFs
    const [sfText, condoText] = await Promise.all([
      fetchPdfText(SF_URL),
      fetchPdfText(CONDO_URL),
    ]);

    // Month detection
    const monthLabel =
      detectMonth(sfText) || detectMonth(condoText) || fallbackMonth();
    const key = monthKeyFromLabel(monthLabel);

    // Parse metrics
    const sfStats = parseRprStats(sfText);
    const condoStats = parseRprStats(condoText);

    const months = {};
    months[key] = {
      sf: sfStats,
      condo: condoStats,
      sfReport: SF_URL,
      condoReport: CONDO_URL,
    };

    // Return only the live month
    return res.status(200).json({ updatedAt, months });
  } catch (err) {
    // Do not crash the site; return a useful error payload
    return res.status(200).json({
      updatedAt: ymd(new Date()),
      months: {},
      error: String(err),
    });
  }
};

/* ============== helpers ============== */
function emptyStats() {
  return {
    medianPrice: null,
    closed: null,
    dom: null,
    monthsSupply: null,
    activeListings: null,
  };
}

async function headOrByte(url) {
  let r = await fetch(url, { method: "HEAD" }).catch(() => null);
  if (!r || !r.ok) {
    r = await fetch(url, {
      method: "GET",
      headers: { range: "bytes=0-0" },
    }).catch(() => null);
  }
  const lm = r?.headers?.get("last-modified") || r?.headers?.get("Last-Modified");
  return { lastModified: lm ? new Date(lm) : null };
}

async function fetchPdfText(url) {
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`PDF fetch failed ${r.status} for ${url}`);
  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab);
  const parsed = await pdfParse(buf);
  return (parsed.text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n");
}

function detectMonth(txt) {
  const months =
    "(January|February|March|April|May|June|July|August|September|October|November|December)";
  const re = new RegExp(`${months}\\s+20\\d{2}`, "i");
  const m = String(txt || "").match(re);
  return m ? titleCase(m[0]) : null;
}

function monthKeyFromLabel(label) {
  if (!label) return fallbackMonthKey();
  const [mon, year] = label.split(/\s+/);
  const map = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };
  const mm =
    map[String(mon || "").toLowerCase()] || new Date(label).getMonth() + 1;
  const yy = parseInt(year, 10);
  return `${yy}-${String(mm).padStart(2, "0")}`;
}

function fallbackMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function fallbackMonthKey() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function titleCase(s) {
  return String(s || "").replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
}

// Robust, simple parser: find values near label lines
function parseRprStats(txt) {
  if (!txt) return emptyStats();

  const lines = String(txt)
    .split(/\n/)
    .map((s) => String(s || "").trim())
    .filter(Boolean);

  const firstInt = (s) => {
    const m = String(s || "").match(/-?\d{1,3}(?:,\d{3})*|-?\d+/);
    if (!m) return null;
    return parseInt(m[0].replace(/,/g, ""), 10);
  };

  const firstFloat = (s) => {
    const m = String(s || "").match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };

  const pctOrMoM = /%|MoM/i;

  function findNextNumber(startIdx, { asFloat = false, maxAhead = 10 } = {}) {
    for (let i = startIdx; i < Math.min(lines.length, startIdx + maxAhead); i++) {
      const ln = lines[i];
      if (pctOrMoM.test(ln)) continue;
      const n = asFloat ? firstFloat(ln) : firstInt(ln);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  const out = emptyStats();

  const reMedianPrice = /median\s+(sold\s+)?price/i;
  const reClosed = /(closed\s+sales|sold\s+listings|total\s+sales|closed\s+listings)/i;
  const reDom = /(median\s+days\s+(in\s+rpr|on\s+market)|days\s+on\s+market)/i;
  const reMonths = /(months\s+of\s+inventory|months\s+(of\s+)?supply)/i;
  const reActive = /(^|\s)active\s+(listings|residential\s+listings)(\s|$)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (out.medianPrice == null && reMedianPrice.test(line)) {
      const n = firstInt(line) ?? findNextNumber(i + 1, { asFloat: false, maxAhead: 6 });
      if (Number.isFinite(n) && n >= 20000 && n <= 2000000) out.medianPrice = n;
      continue;
    }

    if (out.closed == null && reClosed.test(line)) {
      const n = findNextNumber(i + 1, { asFloat: false, maxAhead: 12 });
      if (Number.isFinite(n) && n >= 0 && n < 10000) out.closed = n;
      continue;
    }

    if (out.dom == null && reDom.test(line)) {
      const n = firstInt(line) ?? findNextNumber(i + 1, { asFloat: false, maxAhead: 8 });
      if (Number.isFinite(n) && n >= 0 && n <= 365) out.dom = n;
      continue;
    }

    if (out.monthsSupply == null && reMonths.test(line)) {
      const n = firstFloat(line) ?? findNextNumber(i + 1, { asFloat: true, maxAhead: 8 });
      if (Number.isFinite(n) && n >= 0 && n < 50) out.monthsSupply = Math.round(n * 10) / 10;
      continue;
    }

    if (out.activeListings == null && reActive.test(line)) {
      const n = findNextNumber(i + 1, { asFloat: false, maxAhead: 12 });
      if (Number.isFinite(n) && n >= 0 && n < 50000) out.activeListings = n;
      continue;
    }
  }

  return out;
}
