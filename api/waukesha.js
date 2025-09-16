// api/waukesha.js
// Uses Node 20's built-in fetch (no node-fetch needed)
const RPR_PDF_URL = "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";

export default async function handler(req, res) {
  try {
    const resp = await fetch(RPR_PDF_URL, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/pdf,*/*;q=0.8"
      }
    });

    const contentType = resp.headers.get("content-type") || "";
    const status = resp.status;
    const buf = Buffer.from(await resp.arrayBuffer());

    // Peek at first 200 chars as text (safe even if PDF)
    let sample = "";
    try { sample = buf.toString("utf8").slice(0, 200); } catch { /* ignore */ }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      upstream: {
        status,
        contentType,
        contentLength: buf.length,
        sample
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
