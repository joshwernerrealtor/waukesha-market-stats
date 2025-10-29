// pages/api/updated-at.js
// Returns the most-recent Last-Modified date from the two county RPR PDFs.
// Falls back to today's date if headers are missing.

const SF_URL = "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";
const CONDO_URL = "https://www.narrpr.com/reports-v2/5a675486-5c7b-4bb0-9946-0cffa3070f05/pdf";

export default async function handler(req, res) {
  try {
    const dates = await Promise.all([SF_URL, CONDO_URL].map(getLastModifiedSafe));
    const max = dates.filter(Boolean).sort((a, b) => b.getTime() - a.getTime())[0] || new Date();
    return res.status(200).json({ updatedAt: toISODate(max) });
  } catch {
    return res.status(200).json({ updatedAt: toISODate(new Date()) });
  }
}

async function getLastModifiedSafe(url) {
  try {
    // HEAD avoids downloading the whole PDF
    const r = await fetch(url, { method: "HEAD" });
    const lm = r.headers.get("last-modified") || r.headers.get("Last-Modified");
    return lm ? new Date(lm) : null;
  } catch {
    return null;
  }
}

function toISODate(d) {
  // YYYY-MM-DD local date (keeps your badge simple)
  const tz = new Date(d);
  const y = tz.getFullYear();
  const m = String(tz.getMonth() + 1).padStart(2, "0");
  const day = String(tz.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
