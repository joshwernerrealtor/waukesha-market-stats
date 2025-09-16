// api/waukesha.js
// Parses your public RPR PDF with PDF.js (pdfjs-dist) and returns JSON for the page.

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// ✅ Your PUBLIC county dynamic PDF URL (works in Incognito)
const RPR_PDF_URL =
  "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";

// --- helpers ---
const takeNum = (m) => (m?.[1] || "").replace(/[,$]/g, "");
const toNum = (v) => (v === "" ? null : Number(v));

// Make a safe YYYY-MM key from PDF text; if not found, fallback to today's year-month.
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

// Pull text from the first N pages (enough to catch headline metrics)
async function extractTextFromPdf(arrayBuffer, maxPages = 10) {
  const loadingTask = getDocument({
    data: new Uint8Array(arrayBuffer),
    // Node-friendly settings:
    disableWorker: true,
    isEvalSupported: false,
    disableFontFace: true
  });
  const pdf = await loadingTask.promise;

  let text = "";
  const pages = Math.min(pdf.numPages, maxPages);
  for (let p = 1; p <= pages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((it) => (typeof it.str === "string" ? it.str : ""))
      .join(" ");
    text += pageText + "\n";
  }
  return text;
}

export default async function handler(req, res) {
  // CORS (safe even if same domain)
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
        error: "Expected a PDF but got non-PDF content.",
        contentType: ct,
        sample: sample.slice(0, 200)
      });
    }

    // 2) Extract text with PDF.js
    const arrayBuf = await resp.arrayBuffer();
    const text = await extractTextFromPdf(arrayBuf);

    // 3) Parse metrics (tweak labels here if your PDF wording differs)
    const medianPrice  = toNum(takeNum(text.match(/Median\s+Sale\s+Price\s*\$?([\d,]+)/i)));
    const closed       = toNum(takeNum(text.match(/\bClosed\s+Sales\s*([\d,]+)/i)));
    const dom          = toNum(takeNum(text.match(/Days\s+on\s+Market\s*([\d,]+)/i)));
    const monthsSupply = toNum((text.match(/Months\s+of\s+(?:Inventory|Supply)\s*([\d.]+)/i)?.[1] || "").trim());
    const newListings  = toNum(takeNum(text.match(/\bNew\s+Listings\s*([\d,]+)/i)));

    if ([medianPrice, closed, dom, monthsSupply].some((v) => v == null)) {
      return res.status(422).json({
        error: "Parser needs tuning: one or more metrics not found.",
        found: { medianPrice, closed, dom, monthsSupply, newListings },
        hint: "Copy the exact wording around those metrics from the PDF and we’ll adjust the regex."
      });
    }

    // 4) Build guaranteed YYYY-MM key
    const monthKey = monthKeyFrom(text);

    // 5) Respond in the shape the frontend expects
    const payload = {
      updatedAt: new Date().toISOString().slice(0, 10),
      months: {
        [monthKey]: {
          sf:    { medianPrice, closed, dom, monthsSupply, newListings },
          condo: { medianPrice, closed, dom, monthsSupply, newListings }, // extend later if condo-specific
          sfReport: RPR_PDF_URL,
          condoReport: RPR_PDF_URL
        }
      }
    };

    // Cache ~23h for speed; still fresh for end users
    res.setHeader("Cache-Control", "s-maxage=82800, stale-while-revalidate=3600");
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
