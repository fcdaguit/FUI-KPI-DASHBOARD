# FAST Regional Ops KPI Dashboard

A static, GitHub-Pages-deployable KPI dashboard for the Regional Operations
Manager, consolidating sellout performance across multiple principals
(Shell Lubricants, Monde Nissin, CDO Food, and future suppliers).

No backend, no build step — plain HTML/CSS/JS + Chart.js, reading a single
JSON file that's refreshed from each principal's Google Sheet export.

## How it works

The dashboard supports **two data modes**, and picks automatically between them
on every page load / Refresh click:

1. **Live from Google Sheets** (if `data/sheets-config.json` has any published
   Sheet URLs filled in) — fetches each principal's sheet directly in the
   browser, parses the CSV, and renders it. No server, no API key.
2. **Bundled sample data** (`data/sales-data.json`) — used automatically if
   no live sources are configured, or if a live fetch fails. This is what
   ships out of the box so the dashboard works immediately.

A small badge next to "Data as of" in the header shows which mode is active
(hover it to see any fetch errors).

### Setting up live Google Sheets

1. In each principal's Google Sheet, make sure the tab uses the template
   header (see `data/template.csv`):
   `Branch/Site, Principal/Supplier, Channel, Category, Month, Year, Target Sales, Actual Sales`
2. **File → Share → Publish to web.** Pick the specific tab, format
   **Comma-separated values (.csv)**, click **Publish**.
3. Copy the generated URL (looks like
   `https://docs.google.com/spreadsheets/d/e/<id>/pub?gid=0&single=true&output=csv`).
4. Paste it into `data/sheets-config.json`:
   ```json
   {
     "sources": [
       { "label": "Shell Lubricants", "url": "https://docs.google.com/.../output=csv" },
       { "label": "Monde Nissin", "url": "https://docs.google.com/.../output=csv" },
       { "label": "CDO Food", "url": "" }
     ]
   }
   ```
   Leave a `url` empty for any principal not yet on live Sheets — the
   dashboard just skips it (and falls back to sample data if *no* source
   has a URL yet).
5. Commit and push. The next page load — or clicking **Refresh** — pulls
   live numbers straight from the sheet, no rebuild step needed.

**Important trade-off:** "Publish to web" makes that sheet's data readable
by **anyone with the link**, no Google login required. Fine for internal
targets/actuals as long as the link itself isn't shared publicly — but
don't publish a sheet that has anything more sensitive on other tabs.

### Alternative: manual CSV export (no live link)

If a principal doesn't want to publish their sheet, leave their `url`
empty in `sheets-config.json` and refresh the shared dataset manually
instead:

```
Google Sheet → File → Download → CSV
        │
        ▼
raw/<principal>-<month>.csv
        │
        │  python3 scripts/build_data.py raw/*.csv
        ▼
data/sales-data.json   ← used automatically when no live sources are set
        │
        │  git commit + push
        ▼
GitHub Pages
```

## Project structure

```
index.html              Page shell — header, filters, panels, footer
css/styles.css           FAST brand tokens (blue #0057A0 / red #D62828), layout
js/app.js                 Data loading (live + fallback), filtering, charts, heatmap, recommendations
data/sheets-config.json   Published Google Sheet CSV URLs, one per principal (fill these in)
data/sales-data.json      Fallback/sample dataset, used when no live source is configured
data/template.csv         Header template to hand to each principal's IT admin
scripts/build_data.py     Combines raw CSV exports into data/sales-data.json (manual-export path)
raw/                       Drop new monthly CSV exports here (not committed by default)
```

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly via `file://` will not work — the browser
blocks `fetch()` of local JSON files without a server.)

## Monthly refresh workflow

1. Send `data/template.csv` to each principal's IT admin; they fill in one
   row per Branch/Site × Channel × Category × Month.
2. Download each principal's sheet as CSV into a local `raw/` folder.
3. Run:
   ```bash
   python3 scripts/build_data.py raw/*.csv
   ```
   This validates headers and rewrites `data/sales-data.json`.
4. Commit and push:
   ```bash
   git add data/sales-data.json
   git commit -m "Refresh sales data — <month year>"
   git push
   ```
5. GitHub Pages redeploys automatically (usually within ~1 minute). Anyone
   viewing the live site can also press **Refresh** in the header to
   re-fetch the latest committed JSON without a hard reload.

## Deploying to GitHub Pages

1. Create a new GitHub repository and push this folder's contents to it:
   ```bash
   git init
   git add .
   git commit -m "Initial KPI dashboard"
   git branch -M main
   git remote add origin https://github.com/<your-org>/<repo-name>.git
   git push -u origin main
   ```
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a branch`,
   branch `main`, folder `/ (root)`. Save.
4. GitHub gives you a URL like
   `https://<your-org>.github.io/<repo-name>/` — that's the dashboard link
   to share with the Regional Operations Manager.
5. Every future `git push` to `main` (e.g. after a data refresh) redeploys
   the site automatically — no extra CI configuration needed for a static
   site like this.

## Adding a new principal / supplier

The dashboard has no hard-coded list of principals, branches, channels, or
categories — every filter is derived from whatever data comes back (live or
sample). To onboard a new supplier:

1. Share `data/template.csv` with their IT admin so their sheet uses the
   right headers.
2. Either add their **Publish to web → CSV** URL to `data/sheets-config.json`
   (live), or add their exported CSV to `raw/` and re-run `build_data.py`
   (manual).
3. Nothing in `index.html`, `app.js`, or `styles.css` needs to change.

## Notes on this build

- **Sample data**: `data/sales-data.json` currently ships with realistic
  generated sample data (Jan 2025 – Jul 2026) across the three named
  principals so the dashboard is fully functional out of the box. Replace
  it with real exports via `build_data.py` whenever you're ready.
- **Charts**: Chart.js is loaded from a CDN (`cdn.jsdelivr.net`) — no
  npm install or bundler required, which keeps GitHub Pages deployment a
  plain static-file push.
- **Export to PDF/Excel/PowerPoint** (mentioned in the original spec) is
  not yet wired up — the cleanest static-site approach is a "Print" /
  Save-as-PDF via the browser for now; a dedicated export button can be
  added next (e.g. via `SheetJS` for Excel, `jsPDF` for PDF).
