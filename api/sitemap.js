// api/sitemap.js
export default async function handler(req, res) {
  try {
    // Figure out your public origin (works on Vercel)
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers.host;
    const origin = `${proto}://${host}`;

    // Pull last updated date from your API and anchor at noon UTC
    const api = await fetch(`${origin}/api/waukesha?ts=${Date.now()}`, { cache: "no-store" });
    const data = await api.json();
    const d = data?.updatedAt || new Date().toISOString().slice(0,10);
    const lastmod = `${d}T12:00:00Z`;

    // Build XML
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    // fresh enough, but cache a bit at edge
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=300");
    res.status(200).send(xml);
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
}
