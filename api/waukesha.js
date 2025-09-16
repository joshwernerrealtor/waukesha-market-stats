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

    // 3) Extract metrics (current best patterns)
    function firstNum(patterns) {
      for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]) {
          const raw = (m[1] || "").toString().replace(/[,$\s]/g, "");
          if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
        }
      }
      return null;
    }

    const medianPrice = firstNum([
      /Median\s+(?:Sale|Sold|Sales)\s+Price[\s\S]{0,60}?\$?\s*([\d,]+)/i,
      /Median\s+Price[\s\S]{0,60}?\$?\s*([\d,]+)/i
    ]);

    const closed = firstNum([
      /\bClosed\s+Sales\b[\s\S]{0,80}?([\d,]+)/i,
      /\bSales\s+Closed\b[\s\S]{0,80}?([\d,]+)/i,
      /\bClosings\b[\s\S]{0,80}?([\d,]+)/i,
      /\bClosed\s+Transactions\b[\s\S]{0,80}?([\d,]+)/i
    ]);

    let dom = firstNum([
      /\bMedian\s+Days\s+on\s+Market\b[\s\S]{0,80}?([\d,]+)/i,
      /\bDays\s+on\s+Market\b[\s\S]{0,80}?([\d,]+)/i,
      /\bMedian\s+DOM\b[\s\S]{0,40}?([\d,]+)/i,
      /\bDOM\b[\s\S]{0,20}?([\d,]+)/i,
      /\bMedian\s+Days\s+to\s+(?:Close|Pending)\b[\s\S]{0,80}?([\d,]+)/i
    ]);
    if (dom == null) {
      const m = text.match(/\bDays\s+on\s+Market\b[\s\S]{0,120}?([0-9]{1,3})\s*days?/i);
      if (m?.[1]) dom = Number(m[1]);
    }

    const monthsSupply = firstNum([
      /Months\s+of\s+(?:Inventory|Supply)[\s\S]{0,40}?([\d.]+)/i,
      /Mos\.?\s+Supply[\s\S]{0,40}?([\d.]+)/i
    ]);

    const newListings = firstNum([
      /\bNew\s+Listings\b[\s\S]{0,80}?([\d,]+)/i,
      /\bListings\s+New\b[\s\S]{0,80}?([\d,]+)/i,
      /\bNew\s+Listings\s+Count\b[\s\S]{0,80}?([\d,]+)/i
    ]);

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
