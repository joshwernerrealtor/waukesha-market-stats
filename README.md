# Waukesha Market Stats

Live page: https://waukesha-market-stats.vercel.app/

## What it is
Static HTML + a Serverless API that scrapes county PDFs from RPR and returns monthly KPIs for Single-Family and Condos.

## Structure
- `index.html` — UI (two KPI columns + community links, print/export styles)
- `api/waukesha.js` — fetches & parses PDFs, returns JSON
- (optional) `vercel.json` — cron hitting `/api/waukesha` daily at 11:00 UTC

## Local edit checklist
1. Update community links in `COMMUNITIES` (index.html).
2. Condo PDF link: `CONDO_PDF_URL` in `api/waukesha.js`.
3. Print header: `/logo.png` + contact block in `index.html`.
4. (Optional) Embed mode: `?embed=1` query to trim chrome in iframes.

## Deploy
- Push to `main` → Vercel auto-deploys.
- If capped: Redeploy next day or upgrade plan.

## Cron
```json
{ "crons": [{ "path": "/api/waukesha", "schedule": "0 11 * * *" }] }
