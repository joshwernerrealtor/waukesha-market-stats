// api/waukesha.js
// Minimal probe: fetch the RPR URL and report what comes back.
// (No pdf-parse here — we just check status, headers, and a tiny sample.)

const RPR_PDF_URL =
  "https://www.narrpr.com/reports-v2/c296fac6-035d-4e9a-84fd-28455ab0339f/pdf";

export default async function handler(req, res) {
  try {
    const resp = await fetch(RPR_PDF_URL, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/pdf,*/*;q=0.8",
        "Referer": "https://www.narrpr.com/"
      }
    });

    const contentType = resp.headers.get("content-type") || "";
    const status = resp.status;
    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    let sample = "";
    try { sample = buf.toString("utf8").slice(0, 200); } catch {}

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
    res.status(500).json({ error: String(e?.message || e) });
  }
}
