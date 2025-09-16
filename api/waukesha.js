// api/waukesha.js
import pdf from "pdf-parse";

// Your PUBLIC county dynamic PDF URL:
const RPR_PDF_URL =
  "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";

// --- helpers ---
const takeNum = (m) => (m?.[1] || "").replace(/[,$]/g, "");
const toNum = (v) => (v === "" ? null : Number(v));

// Force a YYYY-MM key from the PDF text; if it can’t be detected, fall back to today’s year-month.
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
  // CORS (safe default; if your page is same domain, this is just harmless)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // 1) Fetch the PDF
    const resp = await fetch(RPR_PDF_URL, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/pdf,*/*;q=0.8",
        "Referer": "https://www.narrpr.com/"
      }
    });

    const ct = resp.headers.get("content-type") || "";
    if (!resp.ok) {
      return res.status(502).json({ error: `Upstream ${resp.status} ${resp.statusText}` });
    }
    if (!ct.includes("application/pdf")) {
      const sample = await resp.text().catch(() => "");
      return res.status(502).json({
        error: "Expected a PDF but got non-PDF content (likely a viewer/login page).",
        contentType: ct,
        sample: sample.slice(0, 200)
      });
    }

    // 2) Parse PDF text
    const buf = Buffer.from(await resp.arrayBuffer());
    const { text } = await pdf(buf);

    // 3) Pull metrics (tweak labels if your PDF uses slightly different wording)
    const medianPrice  = toNum(takeNum(text.match(/Median\s+Sale\s+Price\s*\$?([\d,]+)/i)));
    const closed       = toNum(takeNum(text.match(/\bClosed\s+Sales\s*([\d,]+)/i)));
    const dom          = toNum(takeNum(text.match(/Days\s+on\s+Market\s*([\d,]+)/i)));
    const monthsSupply = toNum((text.match(/Months\s+of\s+(?:Inventory|Supply)\s*([\d.]+)/i)?.[1] || "").trim());
    const newListings  = toNum(takeNum(text.match(/\bNew\s+Listings\s*([\d,]+)/i)));

    if ([medianPrice, closed, dom, monthsSupply].some(v => v == null)) {
      return res.status(422).json({
        error: "Parser needs tuning: one or more metrics not found.",
        found: { medianPrice, closed, dom, monthsSupply, newListings }
      });
    }

    // 4) Build a guaranteed YYYY-MM key
    const monthKey = monthKeyFrom(text);

    // 5) Return JSON in the shape your page expects
    const payload = {
      updatedAt: new Date().toISOString().slice(0, 10),
      months: {
        [monthKey]: {
          sf:    { medianPrice, closed, dom, monthsSupply, newListings },
          condo: { medianPrice, closed, dom, monthsSupply, newListings }, // extend later if you parse condo-specific
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
