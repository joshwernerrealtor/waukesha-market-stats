// api/waukesha.js
// Parses RPR PDFs for Single-Family and Condo, returns both in one payload.

const SF_PDF_URL =
  "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";

// ⬇️ When you have your Condo/Townhome dynamic link, paste it here.
// Leave as "" (empty string) for now; the API will mirror SF into Condo.
const CONDO_PDF_URL = "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf";

// ---------- helpers ----------
function monthKeyFrom(text) {
  const label =
    text.match(/Market\s+Trends.*?for\s+([A-Za-z]+\s+\d{4})/is)?.[1] ||
    text.match(/Updated\s+through\s+([A-Za-z]+\s+\d{4})/i)?.[1] ||
    text.match(/\b([A-Za-z]+\s+\d{4})\b/g)?.[0] ||
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

  // a) After the label: prefer "# of Properties - N", else any number (not a %)
  const a = label.exec(text);
  if (a) {
    const window = text.slice(a.index, Math.min(text.length, a.index + a[0].length + span));
    let m = window.match(/#\s*of\s*Properties\s*[-–—]\s*([\d,]+)/i);
    if (m?.[1]) return Number(m[1].replace(/,/g, ""));
    m = window.match(/(\d{1,3}(?:,\d{3})+|\d{1,4})(?:\.\d+)?(?!\s*%)/);
    if (m?.[1]) return Number(m[1].replace(/,/g, ""));
  }

  // b) Number first, label after
  const b = new RegExp(
    `(\\d{1,3}(?:,\\d{3})+|\\d{1,4})(?:\\.\\d+)?(?!\\s*%)[\\s\\S]{0,${span}}${labelRegexSource}`,
    "i"
  ).exec(text);
  if (b?.[1]) return Number(b[1].replace(/,/g, ""));
  return null;
}

async function fetchTextFromPdf(url) {
  const resp = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/pdf,*/*;q=0.8",
      "Referer": "https://www.narrpr.com/"
    }
  });
  if (!resp.ok) throw new Error(`Upstream ${resp.status} ${resp.statusText}`);
  const ct = resp.headers.get("content-type") || "";
  const ab = await resp.arrayBuffer();
  if (!ct.includes("application/pdf")) {
    throw new Error("Expected PDF but got non-PDF content");
  }
  const mod = await import("pdf-parse/lib/pdf-parse.js");
  const pdfParse = mod.default || mod;
  const { text = "" } = await pdfParse(Buffer.from(ab));
  return text;
}

function parseMetrics(text) {
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

  // DOM (RPR shows "Median Days in RPR" on your PDF)
  let dom = findIntNear(
    "(Median\\s+Days\\s+in\\s+RPR|Median\\s+Days\\s+on\\s+Market|Days\\s+on\\s+Market|Median\\s+DOM|\\bDOM\\b|Median\\s+Days\\s+to\\s+(?:Close|Pending))",
    text
  );
  if (dom == null) {
    const m = text.match(/\bDays\s+on\s+Market\b[\s\S]{0,200}?([0-9]{1,3})\s*days?/i);
    if (m?.[1]) dom = Number(m[1]);
  }

  // Closed (near "Sold Listings")
  const closed = findIntNear(
    "(Closed\\s+(?:Sales|Listings)|Closings|Closed\\s+Transactions|Properties\\s+Sold|Sold\\s+Properties|Total\\s+Closed|Sold\\s+Listings)",
    text
  );

  // Active Listings (from "Active Listings" section)
  const activeListings = (() => {
    const m = text.match(/Active\s+Listings[\s\S]{0,2000}?#\s*of\s*Properties\s*[-–—]\s*([\d,]+)/i);
    return m?.[1] ? Number(m[1].replace(/,/g, "")) : null;
  })();

  // Month key
  const monthKey = monthKeyFrom(text);

  return { medianPrice, closed, dom, monthsSupply, activeListings, monthKey };
}

// ---------- handler ----------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // Parse SF
    const sfText = await fetchTextFromPdf(SF_PDF_URL);
    const sf = parseMetrics(sfText);

    // Parse Condo if a URL is set; otherwise mirror SF
    let condo = sf;
    let condoReportUrl = SF_PDF_URL;
    if (CONDO_PDF_URL && CONDO_PDF_URL.trim()) {
      try {
        const condoText = await fetchTextFromPdf(CONDO_PDF_URL.trim());
        condo = parseMetrics(condoText);
        condoReportUrl = CONDO_PDF_URL.trim();
      } catch (e) {
        // If condo parse fails, keep mirroring SF but note the error.
        console.warn("Condo parse failed:", e?.message || e);
      }
    }

    // Require core SF metrics
    if ([sf.medianPrice, sf.closed, sf.dom, sf.monthsSupply].some(v => v == null)) {
      return res.status(422).json({
        error: "Parser needs tuning for SF: missing one or more metrics.",
        found: sf
      });
    }

    const monthKey = sf.monthKey;
    const payload = {
      updatedAt: new Date().toISOString().slice(0, 10),
      months: {
        [monthKey]: {
          sf: {
            medianPrice: sf.medianPrice,
            closed: sf.closed,
            dom: sf.dom,
            monthsSupply: sf.monthsSupply,
            newListings: null,
            activeListings: sf.activeListings
          },
          condo: {
            medianPrice: condo.medianPrice ?? sf.medianPrice,
            closed: condo.closed ?? sf.closed,
            dom: condo.dom ?? sf.dom,
            monthsSupply: condo.monthsSupply ?? sf.monthsSupply,
            newListings: null,
            activeListings: condo.activeListings ?? sf.activeListings
          },
          sfReport: SF_PDF_URL,
          condoReport: condoReportUrl
        }
      }
    };

    res.setHeader("Cache-Control", "s-maxage=82800, stale-while-revalidate=3600");
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
