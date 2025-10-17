// pages/api/waukesha.js
// Minimal API that matches your index.html expectations.
// Returns months data for Single-Family and Condos plus updatedAt.

export default function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

  // Use the latest month key first. Keep at least 2 months so MoM deltas work.
  const months = {
    "2025-09": {
      sf:   { medianPrice: 459000, closed: 412, dom: 18, monthsSupply: 2.1,  activeListings: 785 },
      condo:{ medianPrice: 289000, closed: 126, dom: 16, monthsSupply: 1.8,  activeListings: 214 },
      sfReport: "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport: "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf"
    },
    "2025-08": {
      sf:   { medianPrice: 452000, closed: 398, dom: 19, monthsSupply: 2.0,  activeListings: 762 },
      condo:{ medianPrice: 282000, closed: 119, dom: 17, monthsSupply: 1.7,  activeListings: 205 },
      sfReport: "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf",
      condoReport: "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf"
    }
  };

  res.status(200).json({
    updatedAt: "2025-09-16",   // this syncs your meta tags and the “Updated” chip in the hero
    months
  });
}
