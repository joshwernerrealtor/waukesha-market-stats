// api/waukesha.js
// Adds ?debug=1 to return extracted PDF text so we can tailor regexes.

const RPR_PDF_URL =
  "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";

const takeNum = (m) => (m?.[1] || "").replace(/[,$\s]/g, "");
const toNum = (v) => (v === "" ? null : Number(v));
function monthKeyFrom(text) {
  const label =
    text.match(/Market\s+Trends.*?for\s+([A-Za-z]+\s+\d{4})/is)?.[1] ||
    text.match(/Updated\s+through\s+([A-Za-z]+\s+\d{4})/i)?.[1] ||
    null;
  if (label) {
    const dt = new Date(`${label} 1`);
    if (!Number.isNaN(dt.getTime())) {
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      return `${y}-${m}`;
    }
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // 1) Fetch
    const resp = await fetch(RPR_PDF_URL, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/pdf,*/*;q=0.8",
        "Referer": "https://www.narrpr.com/"
      }
    });
    if (!resp.ok) return res.status(502).json({ error: `Upstream ${resp.status} ${resp.statusText}` });

    const ct = resp.headers.get("content-type") || "";
    const ab = await resp.arrayBuffer();
    if (!ct.includes("application/pdf")) {
      let sample = "";
      try { sample = Buffer.from(ab).toString("utf8").slice(0, 200); } catch {}
      return res.status(502).json({ error: "Expected PDF, got non-PDF", contentType: ct, sample });
    }

    // 2) Parse text via pdf-parse library file (avoid index debug path)
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdfParse = mod.default || mod;
    const { text = "" } = await pdfParse(Buffer.from(ab));

    // 🔎 DEBUG MODE: show extracted text head so we can tune regex
    if (req.url && req.url.includes("debug=1")) {
      return res.status(200).json({
        length: text.length,
        head: text.slice(0, 3000) // first 3k chars
      });
    }

    // 3) Extract metrics — expanded patterns + avoid grabbing percentages
function numNear(labelRegexSource, text, span = 200) {
  const labelRe = new RegExp(labelRegexSource, "i");

  // a) Label → number shortly after
  const a = labelRe.exec(text);
  if (a) {
    const start = Math.max(0, a.index);
    const end = Math.min(text.length, a.index + a[0].length + span);
    const window = text.slice(start, end);
    const m = window.match(/(\d{1,3}(?:,\d{3})+|\d{1,4})(?:\.\d+)?(?!\s*%)/);
    if (m?.[1]) return Number(m[1].replace(/,/g, ""));
  }

  // b) Number → label shortly after
  const b = new RegExp(
    `(\\d{1,3}(?:,\\d{3})+|\\d{1,4})(?:\\.\\d+)?(?!\\s*%)[\\s\\S]{0,${span}}${labelRegexSource}`,
    "i"
  ).exec(text);
  if (b?.[1]) return Number(b[1].replace(/,/g, ""));

  return null;
}

// Median Sold Price (already working for you)
const medianPrice = (()=>{
  const m =
    text.match(/Median\s+(?:Sold|Sale|Sales)\s+Price[\s\S]{0,80}?\$?\s*([\d,]+)/i) ||
    text.match(/Median\s+Price[\s\S]{0,80}?\$?\s*([\d,]+)/i);
  return m?.[1] ? Number(m[1].replace(/,/g, "")) : null;
})();

// Months of Inventory (decimal)
const monthsSupply = (()=>{
  const m =
    text.match(/Months\s+of\s+(?:Inventory|Supply)[\s\S]{0,60}?([\d.]+)/i) ||
    text.match(/Mos\.?\s+Supply[\s\S]{0,60}?([\d.]+)/i);
  return m?.[1] ? Number(m[1]) : null;
})();

// DOM — your PDF shows "Median Days in RPR"
let dom = numNear(
  "(Median\\s+Days\\s+in\\s+RPR|Median\\s+Days\\s+on\\s+Market|Days\\s+on\\s+Market|Median\\s+DOM|\\bDOM\\b|Median\\s+Days\\s+to\\s+(?:Close|Pending))",
  text
);
if (dom == null) {
  const m = text.match(/\bDays\s+on\s+Market\b[\s\S]{0,120}?([0-9]{1,3})\s*days?/i);
  if (m?.[1]) dom = Number(m[1]);
}

// Closed Sales — lots of variants
const closed = numNear(
  "(Closed\\s+Sales|Sales\\s+Closed|Closings|Closed\\s+Transactions|Closed\\s+Listings|Properties\\s+Sold|Sold\\s+Properties|Total\\s+Closed)",
  text
);

// New Listings — common variants
const newListings = numNear(
  "(New\\s+Listings|Listings\\s+New|Newly\\s+Listed|New\\s+Listings\\s+Count|Listings\\s+Added|Added\\s+Listings)",
  text
);

if ([medianPrice, closed, dom, monthsSupply].some(v => v == null)) {
  return res.status(422).json({
    error: "Parser needs tuning: metric(s) not found.",
    found: { medianPrice, closed, dom, monthsSupply, newListings }
  });
}

    // 4) Month key + payload
    const monthKey = monthKeyFrom(text);
    const payload = {
      updatedAt: new Date().toISOString().slice(0, 10),
      months: {
        [monthKey]: {
          sf:    { medianPrice, closed, dom, monthsSupply, newListings },
          condo: { medianPrice, closed, dom, monthsSupply, newListings },
          sfReport: RPR_PDF_URL,
          condoReport: RPR_PDF_URL
        }
      }
    };

    res.setHeader("Cache-Control", "s-maxage=82800, stale-while-revalidate=3600");
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
