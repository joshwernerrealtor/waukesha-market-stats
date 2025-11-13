// pages/api/waukesha.js
// Simple, safe stub: returns hard-coded data for a few months.
// Shape matches what index.html expects.

export default function handler(req, res) {
  // Cache for 6 hours at the edge, allow stale for a day
  res.setHeader(
    "Cache-Control",
    "s-maxage=21600, stale-while-revalidate=86400"
  );

  const months = {
    "2025-08": {
      sf: {
        medianPrice: 445000,
        closed: 395,
        dom: 19,
        monthsSupply: 2.0,
        activeListings: 760
      },
      condo: {
        medianPrice: 275000,
        closed: 118,
        dom: 17,
        monthsSupply: 1.7,
        activeListings: 205
      },
      sfReport:
        "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport:
        "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf"
    },
    "2025-09": {
      sf: {
        medianPrice: 459000,
        closed: 412,
        dom: 18,
        monthsSupply: 2.1,
        activeListings: 785
      },
      condo: {
        medianPrice: 289000,
        closed: 126,
        dom: 16,
        monthsSupply: 1.8,
        activeListings: 214
      },
      sfReport:
        "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport:
        "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf"
    },
    "2025-10": {
      // Rough example numbers for October; you can tweak these
      sf: {
        medianPrice: 462000,
        closed: 405,
        dom: 19,
        monthsSupply: 2.2,
        activeListings: 790
      },
      condo: {
        medianPrice: 292000,
        closed: 120,
        dom: 17,
        monthsSupply: 1.9,
        activeListings: 220
      },
      sfReport:
        "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport:
        "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf"
    }
  };

  // Latest month key for convenience if you ever need it
  const latestKey = Object.keys(months).sort().pop();

  res.status(200).json({
    updatedAt: "2025-10-31",
    latest: latestKey,
    months
  });
}
