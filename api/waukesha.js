// api/waukesha.js
// Parses your public RPR PDF and returns JSON. Uses pdf-parse's library file (no debug path).

const RPR_PDF_URL =
  "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";

// Helpers
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
    // 1) Fetch the PDF
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

    // 2) Use pdf-parse library file (avoids index.js debug path)
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdfParse = mod.default || mod;
    const { text = "" } = await pdfParse(Buffer.from(ab));

   // 3) Extract metrics (expanded patterns for RPR wording)
function firstNum(patterns, text) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return toNum(takeNum(m));
  }
  return null;
}

const medianPrice = firstNum([
  /Median\s+(?:Sale|Sold|Sales)\s+Price[^0-9$]*\$?\s*([\d,]+)/i,
  /Median\s+Price[^0-9$]*\$?\s*([\d,]+)/i
], text);

const closed = firstNum([
  /\bClosed\s+Sales\b[^0-9]*([\d,]+)/i,
  /\bSales\s+Closed\b[^0-9]*([\d,]+)/i,
  /\bClosings\b[^0-9]*([\d,]+)/i
], text);

const dom = firstNum([
  /\bMedian\s+Days\s+on\s+Market\b[^0-9]*([\d,]+)/i,
  /\bDays\s+on\s+Market\b[^0-9]*([\d,]+)/i,
  /\bMedian\s+DOM\b[^0-9]*([\d,]+)/i,
  /\bDOM\b[^0-9]*([\d,]+)/i
], text);

const monthsSupply = firstNum([
  /Months\s+of\s+(?:Inventory|Supply)\s*([\d.]+)/i,
  /Mos\.?\s+Supply\s*([\d.]+)/i
], text);

const newListings = firstNum([
  /\bNew\s+Listings\b[^0-9]*([\d,]+)/i,
  /\bListings\s+New\b[^0-9]*([\d,]+)/i
], text);

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
