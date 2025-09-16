// api/waukesha.js
// Fetches your public RPR PDF, parses key stats, supports ?debug=1 and ?debug=new
export const config = { runtime: 'nodejs20.x' };

const RPR_PDF_URL =
  "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";

// --- helpers ---
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

function findIntNear(labelRegexSource, text, span = 800) {
  const label = new RegExp(labelRegexSource, "i");

  // a) After the label: look for "# of Properties - N" first, then any number (not a %)
  const a = label.exec(text);
  if (a) {
    const window = text.slice(a.index, Math.min(text.length, a.index + a[0].length + span));
    let m = window.match(/#\s*of\s*Properties\s*[-–—]\s*([\d,]+)/i);
    if (m?.[1]) return Number(m[1].replace(/,/g, ""));
    m = window.match(/(\d{1,3}(?:,\d{3})+|\d{1,4})(?:\.\d+)?(?!\s*%)/);
    if (m?.[1]) return Number(m[1].replace(/,/g, ""));
  }

  // b) Number appears first, then the label
  const b = new RegExp(
    `(\\d{1,3}(?:,\\d{3})+|\\d{1,4})(?:\\.\\d+)?(?!\\s*%)[\\s\\S]{0,${span}}${labelRegexSource}`,
    "i"
  ).exec(text);
  if (b?.[1]) return Number(b[1].replace(/,/g, ""));
  return null;
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

    // 2) Parse text (use pdf-parse library file to avoid test-path issues)
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdfParse = mod.default || mod;
    const { text = "" } = await pdfParse(Buffer.from(ab));

    // ---- DEBUG (stop here if query has ?debug=...) ----
    try {
      const urlObj = new URL(req.url, "http://local");
      const dbg = urlObj.searchParams.get("debug");
      if (dbg === "1") {
        return res.status(200).json({ length: text.length, head: text.slice(0, 4000) });
      }
      if (dbg === "new") {
        const m = text.match(/New\s+Listings/i);
        if (!m) return res.status(200).json({ found: false, note: "No 'New Listings' label found." });
        const idx = m.index;
        const start = Math.max(0, idx - 500);
        const end = Math.min(text.length, idx + 2500);
        const snippet = text.slice(start, end);
        return res.status(200).json({ found: true, at: idx, snippet });
      }
    } catch {
      /* ignore */
    }
    // ---- END DEBUG ----

    // 3) Extract metrics
    // Median Sold Price
    const medianPrice = (() => {
      const m =
        text.match(/Median\s+(?:Sold|Sale|Sales)\s+Price[\s\S]{0,120}?\$?\s*([\d,]+)/i) ||
        text.match(/Median\s+Price[\s\S]{0,120}?\$?\s*([\d,]+)/i);
      return m?.[1] ? Number(m[1].replace(/,/g, "")) : null;
    })();

    // Months of Inventory
    const monthsSupply = (() => {
      const m =
        text.match(/Months\s+of\s+(?:Inventory|Supply)[\s\S]{0,120}?([\d.]+)/i) ||
        text.match(/Mos\.?\s+Supply[\s\S]{0,120}?([\d.]+)/i);
      return m?.[1] ? Number(m[1]) : null;
    })();

    // DOM (your PDF shows "Median Days in RPR")
    let dom = findIntNear(
      "(Median\\s+Days\\s+in\\s+RPR|Median\\s+Days\\s+on\\s+Market|Days\\s+on\\s+Market|Median\\s+DOM|\\bDOM\\b|Median\\s+Days\\s+to\\s+(?:Close|Pending))",
      text
    );
    if (dom == null) {
      const m = text.match(/\bDays\s+on\s+Market\b[\s\S]{0,200}?([0-9]{1,3})\s*days?/i);
      if (m?.[1]) dom = Number(m[1]);
    }

    // Closed Sales — near "Sold Listings" section with "# of Properties - N"
    const closed = findIntNear(
      "(Closed\\s+(?:Sales|Listings)|Closings|Closed\\s+Transactions|Properties\\s+Sold|Sold\\s+Properties|Total\\s+Closed|Sold\\s+Listings)",
      text
    );

    // Active Listings — pull "# of Properties - N" from the Active section
    const activeListings = (() => {
      const m = text.match(/Active\s+Listings[\s\S]{0,2000}?#\s*of\s*Properties\s*[-–—]\s*([\d,]+)/i);
      return m?.[1] ? Number(m[1].replace(/,/g, "")) : null;
    })();

    // New Listings — many county PDFs don’t include this; try, but allow null
    let newListings = null;
    const nlWide = text.match(/New\s+Listings[\s\S]{0,2000}?#\s*of\s*Properties\s*[-–—]\s*([\d,]+)/i);
    if (nlWide?.[1]) {
      newListings = Number(nlWide[1].replace(/,/g, ""));
    } else {
      newListings = findIntNear(
        "(New\\s+Listings|Listings\\s+New|Newly\\s+Listed|New\\s+Listings\\s+Count|Listings\\s+Added|Added\\s+Listings)",
        text,
        1200
      );
    }

    // Require the core four; allow newListings to be null
    if ([medianPrice, closed, dom, monthsSupply].some(v => v == null)) {
      return res.status(422).json({
        error: "Parser needs tuning: metric(s) not found.",
        found: { medianPrice, closed, dom, monthsSupply, newListings, activeListings }
      });
    }

    // 4) Respond
    const monthKey = monthKeyFrom(text);
    const payload = {
      updatedAt: new Date().toISOString().slice(0, 10),
      months: {
        [monthKey]: {
          sf:    { medianPrice, closed, dom, monthsSupply, newListings, activeListings },
          condo: { medianPrice, closed, dom, monthsSupply, newListings, activeListings },
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
