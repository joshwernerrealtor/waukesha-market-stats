import fetch from "node-fetch";
import pdf from "pdf-parse";

// County dynamic PDF
const RPR_PDF_URL =
  "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";

const takeNum = (m) => (m?.[1] || "").replace(/[,$]/g, "");
const toNum = (v) => (v === "" ? null : Number(v));

export default async function handler(req, res) {
  try {
    const resp = await fetch(RPR_PDF_URL, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!resp.ok) throw new Error(`RPR fetch failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());

    const data = await pdf(buf);
    const text = data.text;

    const monthLabel =
      text.match(/Market\s+Trends.*?for\s+([A-Za-z]+\s+\d{4})/is)?.[1] ||
      text.match(/Updated\s+through\s+([A-Za-z]+\s+\d{4})/i)?.[1] ||
      null;

    const medianPrice  = toNum(takeNum(text.match(/Median\s+Sale\s+Price\s*\$?([\d,]+)/i)));
    const closed       = toNum(takeNum(text.match(/\bClosed\s+Sales\s*([\d,]+)/i)));
    const dom          = toNum(takeNum(text.match(/Days\s+on\s+Market\s*([\d,]+)/i)));
    const monthsSupply = toNum((text.match(/Months\s+of\s+(?:Inventory|Supply)\s*([\d.]+)/i)?.[1] || "").trim());
    const newListings  = toNum(takeNum(text.match(/\bNew\s+Listings\s*([\d,]+)/i)));

    if ([medianPrice, closed, dom, monthsSupply].some(v => v == null)) {
      throw new Error("Parser needs tuning: some metrics not found in PDF.");
    }

    let key = "latest";
    if (monthLabel) {
      const dt = new Date(`${monthLabel} 1`);
      if (!isNaN(dt)) key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    }

    const json = {
      updatedAt: new Date().toISOString().slice(0, 10),
      months: {
        [key]: {
          sf:    { medianPrice, closed, dom, monthsSupply, newListings },
          condo: { medianPrice, closed, dom, monthsSupply, newListings },
          sfReport: RPR_PDF_URL,
          condoReport: RPR_PDF_URL
        }
      }
    };

    res.setHeader("Cache-Control", "s-maxage=82800, stale-while-revalidate=3600");
    res.status(200).json(json);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
