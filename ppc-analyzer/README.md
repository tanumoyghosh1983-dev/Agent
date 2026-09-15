# PPC Landing Page Performance Analyzer

Analyzes PPC landing pages for virtualemployee.com by correlating CSV
conversion data with an AI critique of the live page (screenshots + Claude
vision), to help identify *why* some pages convert better than others.

Three ways to run it:
- **The web app** (`site/index.html`) — upload a CSV, click Analyze, watch
  progress, see the report. Runs on Netlify + GitHub Actions; see
  [Web app](#web-app-upload--analyze) below.
- **GitHub Actions manually** — trigger `ppc-analyzer.yml` from the Actions
  tab without the web app UI. See [Running via GitHub Actions](#running-via-github-actions).
- **Your own machine** — the scripts directly, useful for debugging. See
  [Local setup](#local-setup).

The actual pipeline (screenshotting live pages, calling the paid Claude
API) always runs on GitHub Actions or your own machine — **never inside
Netlify's build**, since Netlify's build environment can't run a real
headless browser against arbitrary live URLs the way this needs.

## Pipeline

1. **`scripts/parse-csv.js` + `scripts/rank.js`** — parses the CSV export,
   extracts Page Name/URL/Writer/Designer + Total Session/Conversion
   Goals/Conversion Rate, ranks pages (top/bottom by conversion rate,
   by session volume, high-traffic/low-conversion), writes
   `raw/pages.json` and `raw/test-batch.json` (top 5 + bottom 5).
2. **`scripts/capture.js`** — Playwright loads each URL at desktop
   (1440×900) and mobile (390×844) viewports, takes full-page screenshots
   (capped at 8000px tall — Claude's vision API max image dimension),
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
   and writes a single `site/report/index.html` with embedded screenshots.

`scripts/analyze.js` runs all four steps in sequence and pauses for
confirmation before the paid critique step (unless `--yes` is passed).

## Web app (upload + analyze)

`site/index.html` is a small app: pick a CSV, set options, click **Analyze**,
and watch progress live. Under the hood it doesn't run the pipeline inside
the browser — it calls a Netlify Function that commits your CSV to this
repo and triggers the same GitHub Actions workflow described above, then
polls GitHub for status until the report is ready.

### One-time setup

**1. Create a GitHub token** the app can use to commit the CSV and trigger
the workflow on your behalf:
- Go to [github.com/settings/tokens](https://github.com/settings/tokens) →
  **Generate new token (classic)**
- Scopes: `repo` and `workflow`
- Copy the token (starts `ghp_...`) — you won't see it again

**2. Connect this repo to Netlify** (if not already):
- Netlify → **Add new site → Import an existing project → GitHub** → pick
  this repo
- **Base directory:** `ppc-analyzer`
- **Publish directory:** `site` (auto-filled from `netlify.toml`)
- Deploy

**3. Add environment variables** on that Netlify site (**Site configuration
→ Environment variables**):
| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | the token from step 1 |
| `GITHUB_OWNER` | `tanumoyghosh1983-dev` |
| `GITHUB_REPO` | `Agent` |
| `GITHUB_BRANCH` | `claude/feature-recommendations-v0xuna` (or whatever branch you deploy from) |
| `APP_ACCESS_PASSWORD` | any password you choose — the app is on a public URL, this keeps random visitors from triggering paid runs |

**4. Add the `ANTHROPIC_API_KEY` secret to the GitHub repo** too (Settings →
Secrets and variables → Actions) — the workflow itself still needs this,
same as running it manually. See [Running via GitHub Actions](#running-via-github-actions).

After a redeploy, open the Netlify site URL, enter the app password,
upload a CSV, and click Analyze.

## Local setup

```bash
cd ppc-analyzer
npm install
npx playwright install chromium   # downloads a browser Playwright can drive
export ANTHROPIC_API_KEY=sk-ant-...   # only needed before the critique step
```

## Usage (local scripts)

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
  critiques (raw output for manual review, not just the final report;
  also uploaded as a downloadable build artifact when run via GitHub Actions)
- `screenshots/` — full-page PNGs, desktop + mobile per page
- `site/report/index.html` — final ranked report with embedded screenshots,
  scores, and cross-page pattern observations

## Important caveat

**Correlation is not causation.** The report flags this explicitly: traffic
source quality, keyword intent, ad targeting, and seasonality (visible in
the CSV's month-by-month history, which varies a lot per page) also drive
conversion rate and aren't visible on the page itself. Treat surfaced
patterns as hypotheses to test, not proven causes.

## Running via GitHub Actions

`.github/workflows/ppc-analyzer.yml` runs the full pipeline (rank → capture →
critique → report) on GitHub's own runners and commits the updated
`site/report/` back to this branch. The web app above triggers this same
workflow for you; this section is for triggering it directly instead.

**Trigger:** manual only ("Run workflow" in the Actions tab, or the web
app's Analyze button, or the API) — it never runs on a schedule or on push,
since every run calls the paid Claude API.

**One-time setup:**
1. In the repo settings, add a secret: **Settings → Secrets and variables →
   Actions → New repository secret** → name `ANTHROPIC_API_KEY`, value your
   Anthropic API key.
2. That's it — `npm ci` and `playwright install` are handled by the workflow.

**To run:** go to the **Actions** tab → **PPC Landing Page Analyzer** →
**Run workflow**. Inputs:
- `csv_path` — defaults to `ppc-analyzer/data/PPC_Dashboard_Report.csv`
  (update this after re-exporting a fresh CSV and committing it)
- `top_n` — top/bottom N pages per ranking category (default 5)
- `min_sessions` — minimum sessions for reliable ranking (default 100)
- `scope` — `test-batch` (top+bottom N, default) or `all` (every page —
  more API cost, more runtime)

The run uploads `raw/` and `screenshots/` as a downloadable build artifact
(30-day retention) for manual review, and commits the regenerated
`site/report/index.html` (+ `site/report/screenshots/`) straight to this
branch — which also updates the live Netlify site if one is connected,
since Netlify redeploys on push.

## Deploying to Netlify

Netlify hosts `site/` — the upload-and-analyze app plus the generated
report at `site/report/`. It never runs the capture/critique pipeline
itself (see the note at the top of this file); the Analyze button's
Netlify Function only commits the CSV and triggers GitHub Actions, which
does the real work.

Connect this repo to Netlify with **Base directory: `ppc-analyzer`** and
**Publish directory: `site`** (see `netlify.toml` in this folder — already
configured). See [Web app](#web-app-upload--analyze) above for the
required environment variables.

If you'd rather just push a report without the web app: run the pipeline
locally or via GitHub Actions, then commit/push the regenerated
`site/report/` — Netlify redeploys automatically on push.
