// pages/api/waukesha-live.js
// Returns Waukesha stats + updatedAt that tracks when RPR refreshed the PDFs.
// Priority for updatedAt (first-good wins):
// 1) Max(Last-Modified) from the two RPR PDF URLs (HEAD, fallback GET range)
// 2) WAU_UPDATED_AT env var (YYYY-MM-DD)
// 3) First day of the latest month key (YYYY-MM-01)

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");

  // ----- YOUR CURRENT DATA (update these when you refresh from RPR) -----
  const months = {
    "2025-09": {
      sf:     { medianPrice: 520000, dom: 48,    monthsSupply: 1.48 },
      condo:  { medianPrice: 389500, dom: 54,    monthsSupply: 2.61 },
      sfReport:    "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport: "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf"
    },
    "2025-08": {
      sf:     { medianPrice: 509600, dom: 48.96, monthsSupply: 1.5096 },
      condo:  { medianPrice: 381710, dom: 55.08, monthsSupply: 2.6622 },
      sfReport:    "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport: "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf"
    }
  };
  // ----------------------------------------------------------------------

  try {
    // Find the newest RPR PDF "Last-Modified" among the latest month’s links
    const latestKey = Object.keys(months).sort().pop();
    const latest = months[latestKey] || {};
    const urls = [latest.sfReport, latest.condoReport].filter(Boolean);

    const lmDates = [];
    for (const u of urls) {
      try {
        const d = await lastModifiedDate(u);
        if (d) lmDates.push(d);
      } catch {}
    }

    let updatedAt = null;

    if (lmDates.length) {
      const newest = new Date(Math.max(...lmDates.map(d => d.getTime())));
      updatedAt = formatYMD(newest);
    }

    if (!updatedAt) {
      const envDate = process.env.WAU_UPDATED_AT;
      if (envDate && /^\d{4}-\d{2}-\d{2}$/.test(envDate)) updatedAt = envDate;
    }

    if (!updatedAt && latestKey) {
      const [yy, mm] = latestKey.split("-").map(Number);
      updatedAt = formatYMD(new Date(yy, mm - 1, 1));
    }

    res.status(200).json({ updatedAt, months });
  } catch (err) {
    const latestKey = Object.keys(months).sort().pop() || "2025-01";
    const [yy, mm] = latestKey.split("-").map(Number);
    res.status(200).json({
      updatedAt: formatYMD(new Date(yy, mm - 1, 1)),
      months,
      error: String(err)
    });
  }
}

/* ============== helpers ============== */

async function lastModifiedDate(url) {
  let res = await fetch(url, { method: "HEAD" }).catch(() => null);
  if (!res || !res.ok) {
    // Some CDNs don’t allow HEAD; grab first byte so we still get headers
    res = await fetch(url, { method: "GET", headers: { range: "bytes=0-0" } }).catch(() => null);
  }
  if (!res || !res.ok) return null;
  const lm = res.headers.get("last-modified") || res.headers.get("Last-Modified");
  if (!lm) return null;
  const d = new Date(lm);
  return isNaN(d.getTime()) ? null : d;
}

function formatYMD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
