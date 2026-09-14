# PPC Landing Page Performance Analyzer

Analyzes PPC landing pages for virtualemployee.com by correlating CSV
conversion data with an AI critique of the live page (screenshots + Claude
vision), to help identify *why* some pages convert better than others.

**This must be run locally** (or in any environment with unrestricted
outbound internet access) — it launches a real headless browser against
live URLs and calls the paid Claude API. It will not run inside a network-
sandboxed CI/build environment such as Netlify's build step.

## Pipeline

1. **`scripts/parse-csv.js` + `scripts/rank.js`** — parses the CSV export,
   extracts Page Name/URL/Writer/Designer + Total Session/Conversion
   Goals/Conversion Rate, ranks pages (top/bottom by conversion rate,
   by session volume, high-traffic/low-conversion), writes
   `raw/pages.json` and `raw/test-batch.json` (top 5 + bottom 5).
2. **`scripts/capture.js`** — Playwright loads each URL at desktop
   (1440×900) and mobile (390×844) viewports, takes full-page screenshots,
   extracts title/H1s/H2s/copy/CTA count & text/image count/form fields/
   above-the-fold status, measures load time. Errors (404, timeout,
   redirect) are logged per-page, not fatal to the batch. Rate-limited via
   `--delay` between requests and `--concurrency` cap.
3. **`scripts/critique.js`** — sends each page's screenshot(s) + extracted
   content to Claude (vision) for a structured JSON critique (CTA
   visibility/clarity, message match, visual hierarchy, trust signals,
   mobile usability, copy scannability, broken/dated flags).
   **Costs money per page** — requires `ANTHROPIC_API_KEY`.
4. **`scripts/report.js`** — merges critique + CSV conversion data,
   computes basic statistical groupings (e.g. "CTA above fold vs. not"),
   and writes a single `report/index.html` with embedded screenshots.

`scripts/analyze.js` runs all four steps in sequence and pauses for
confirmation before the paid critique step (unless `--yes` is passed).

## Setup

```bash
cd ppc-analyzer
npm install
npx playwright install chromium   # downloads a browser Playwright can drive
export ANTHROPIC_API_KEY=sk-ant-...   # only needed before the critique step
```

## Usage

Test batch first (top 5 + bottom 5 by conversion rate, min 100 sessions):

```bash
node scripts/analyze.js data/PPC_Dashboard_Report.csv
```

Re-run individual steps as needed:

```bash
node scripts/rank.js data/PPC_Dashboard_Report.csv --top 5 --min-sessions 100
node scripts/capture.js raw/test-batch.json --concurrency 2 --delay 1500
node scripts/critique.js raw/capture-results.json --delay 1000
node scripts/report.js
```

Once you're happy with the test batch, run the full page list:

```bash
node scripts/analyze.js data/PPC_Dashboard_Report.csv --all --yes
```

Fresh CSV export later — just re-run the same command with the new file.

## Output

- `raw/` — full JSON dataset, ranked lists, capture results, per-page
  critiques (raw output for manual review, not just the final report)
- `screenshots/` — full-page PNGs, desktop + mobile per page
- `report/index.html` — final ranked report with embedded screenshots,
  scores, and cross-page pattern observations

## Important caveat

**Correlation is not causation.** The report flags this explicitly: traffic
source quality, keyword intent, ad targeting, and seasonality (visible in
the CSV's month-by-month history, which varies a lot per page) also drive
conversion rate and aren't visible on the page itself. Treat surfaced
patterns as hypotheses to test, not proven causes.

## Deploying the report to Netlify

Netlify should host only the **finished static report** — not run this
pipeline. After generating `report/index.html` locally:

```bash
netlify deploy --dir=report --prod
```

or connect this repo to Netlify with **Base directory: `ppc-analyzer`** and
**Publish directory: `report`** (see `netlify.toml` in this folder) and
commit/push a freshly generated `report/` whenever you want the live page
updated. Netlify itself never runs `capture.js` or `critique.js`.
