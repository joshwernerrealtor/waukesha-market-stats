// api/waukesha.js
// Stub months + live newest month merged at request time

export default async function handler(req, res) {
  // IMPORTANT: avoid caching while we debug. You can re-enable caching later.
  res.setHeader("Cache-Control", "no-store");

  const months = {
    "2025-08": {
      sf: { medianPrice: 445000, closed: 395, dom: 19, monthsSupply: 2.0, activeListings: 760 },
      condo: { medianPrice: 275000, closed: 118, dom: 17, monthsSupply: 1.7, activeListings: 205 },
      sfReport: "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport: "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf"
    },
    "2025-09": {
      sf: { medianPrice: 459000, closed: 412, dom: 18, monthsSupply: 2.1, activeListings: 785 },
      condo: { medianPrice: 289000, closed: 126, dom: 16, monthsSupply: 1.8, activeListings: 214 },
      sfReport: "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport: "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf"
    },
    "2025-10": {
      sf: { medianPrice: 462000, closed: 405, dom: 19, monthsSupply: 2.2, activeListings: 790 },
      condo: { medianPrice: 292000, closed: 120, dom: 17, monthsSupply: 1.9, activeListings: 220 },
      sfReport: "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport: "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf"
    }
  };

  try {
    // Build the correct origin on Vercel
    const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
    const host = req.headers.host;
    const origin = `${proto}://${host}`;

    // Pull live month from the parser
    const liveUrl = `${origin}/api/waukesha-live?ts=${Date.now()}`;
    const live = await fetch(liveUrl, { cache: "no-store" }).then(r => r.json());

    if (live?.months && typeof live.months === "object") {
      // Merge: live overwrites same month key if present
      Object.assign(months, live.months);
    }

    const keys = Object.keys(months).sort(); // YYYY-MM sorts correctly
    const latestKey = keys.length ? keys[keys.length - 1] : null;

    // Prefer the live updatedAt if present; fall back to the stub date
    const updatedAt = live?.updatedAt || "2025-10-31";

    return res.status(200).json({
      updatedAt,
      latest: latestKey,
      months
    });
  } catch (err) {
    // If live fetch fails, still return stub so site doesn’t break
    const latestKey = Object.keys(months).sort().pop();
    return res.status(200).json({
      updatedAt: "2025-10-31",
      latest: latestKey,
      months,
      liveError: String(err)
    });
  }
}
