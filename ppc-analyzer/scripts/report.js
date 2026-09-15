#!/usr/bin/env node
// Usage: node scripts/report.js
//
// Merges raw/critiques.json (AI critique + extracted content per page) with
// raw/pages.json (CSV conversion data) and raw/capture-results.json
// (screenshot paths, load times), computes basic statistical groupings
// ("pages with X convert Y% better on average"), and writes a single
// self-contained HTML report to report/index.html with embedded
// screenshots (as relative <img> paths, copied alongside the report).

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function loadJson(p, fallback = null) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function fmtPct(n) {
  return n === null || n === undefined ? "n/a" : `${n.toFixed(2)}%`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EXPORT_COLUMNS = [
  ["pageName", (r) => r.pageName],
  ["url", (r) => r.url],
  ["conversionRate", (r) => r.conversionRate],
  ["totalSessions", (r) => r.totalSessions],
  ["totalConversions", (r) => r.totalConversions],
  ["writer", (r) => r.writer],
  ["designer", (r) => r.designer],
  ["ctaVisibilityScore", (r) => r.critique.ctaVisibility?.score],
  ["ctaClarityScore", (r) => r.critique.ctaClarity?.score],
  ["messageMatchScore", (r) => r.critique.messageMatchPotential?.score],
  ["visualHierarchyScore", (r) => r.critique.visualHierarchy?.score],
  ["trustSignalsScore", (r) => r.critique.trustSignals?.score],
  ["mobileUsabilityScore", (r) => r.critique.mobileUsability?.score],
  ["copyScannabilityScore", (r) => r.critique.copyScannability?.score],
  ["brokenOrDated", (r) => (r.critique.brokenOrDated?.found ? "yes" : "no")],
  ["ctaOrFoldAboveDesktop", (r) => r.ctaOrFoldDesktop],
  ["ctaOrFoldAboveMobile", (r) => r.ctaOrFoldMobile],
  ["wordCount", (r) => r.wordCount],
  ["loadTimeMs", (r) => r.loadTimeMs],
  ["overallImpression", (r) => r.critique.overallImpression],
  ["topRecommendation", (r) => r.critique.topRecommendation],
  // CSV can't embed images - these filenames let you find the matching
  // screenshot in this run's screenshots/ folder (next to this CSV) or in
  // the HTML report, where they're shown inline.
  ["desktopScreenshotFile", (r) => r.desktopScreenshot],
  ["mobileScreenshotFile", (r) => r.mobileScreenshot],
];

function buildZip(sourceDir, zipDestPath) {
  try {
    mkdirSync(path.dirname(zipDestPath), { recursive: true });
    // Zip the *contents* of sourceDir (via cwd), not the folder itself, so
    // extracting the archive drops index.html/export.csv/screenshots/
    // directly where you unzip it - no wrapper folder to dig through.
    execFileSync("zip", ["-r", "-q", "-X", path.resolve(zipDestPath), "."], { cwd: sourceDir });
    return true;
  } catch (err) {
    console.warn(`Could not create ZIP bundle (is 'zip' installed?): ${err.message}`);
    return false;
  }
}

function buildCsv(merged) {
  const header = EXPORT_COLUMNS.map(([name]) => csvCell(name)).join(",");
  const rows = merged.map((r) => EXPORT_COLUMNS.map(([, get]) => csvCell(get(r))).join(","));
  return [header, ...rows].join("\n") + "\n";
}

function run() {
  const pagesData = loadJson("raw/pages.json");
  const critiques = loadJson("raw/critiques.json", []);
  const captureResults = loadJson("raw/capture-results.json", []);

  if (!pagesData) {
    console.error("raw/pages.json not found. Run `npm run rank` first.");
    process.exit(1);
  }
  if (!critiques.length) {
    console.error("raw/critiques.json not found or empty. Run `npm run critique` first.");
    process.exit(1);
  }

  const pageByUrl = new Map(pagesData.pages.map((p) => [p.url, p]));
  const captureByUrl = new Map(captureResults.map((c) => [c.url, c]));

  // Merge: one row per successfully critiqued page.
  const merged = critiques
    .filter((c) => c.critique)
    .map((c) => {
      const csvRow = pageByUrl.get(c.url) || {};
      const capture = captureByUrl.get(c.url) || {};
      const desktop = capture.viewports?.desktop || {};
      const mobile = capture.viewports?.mobile || {};
      return {
        pageName: c.pageName,
        url: c.url,
        slug: c.slug,
        conversionRate: csvRow.conversionRate ?? null,
        totalSessions: csvRow.totalSessions ?? null,
        totalConversions: csvRow.totalConversions ?? null,
        writer: csvRow.writer,
        designer: csvRow.designer,
        critique: c.critique,
        ctaOrFoldDesktop: desktop.ctaOrFormAboveFold ?? null,
        ctaOrFoldMobile: mobile.ctaOrFormAboveFold ?? null,
        wordCount: desktop.wordCount ?? null,
        loadTimeMs: desktop.loadTimeMs ?? null,
        desktopScreenshot: desktop.screenshotPath ? path.basename(desktop.screenshotPath) : null,
        mobileScreenshot: mobile.screenshotPath ? path.basename(mobile.screenshotPath) : null,
      };
    })
    .filter((r) => r.conversionRate !== null)
    .sort((a, b) => b.conversionRate - a.conversionRate);

  // --- Basic statistical groupings (correlation, not causation) ---
  const withFold = merged.filter((r) => r.ctaOrFoldDesktop === true).map((r) => r.conversionRate);
  const withoutFold = merged.filter((r) => r.ctaOrFoldDesktop === false).map((r) => r.conversionRate);

  const sortedByWordCount = [...merged].filter((r) => r.wordCount !== null).sort((a, b) => a.wordCount - b.wordCount);
  const halfIdx = Math.floor(sortedByWordCount.length / 2);
  const shorterCopy = sortedByWordCount.slice(0, halfIdx).map((r) => r.conversionRate);
  const longerCopy = sortedByWordCount.slice(halfIdx).map((r) => r.conversionRate);

  const withTrust = merged.filter((r) => (r.critique.trustSignals?.score ?? 0) >= 4).map((r) => r.conversionRate);
  const withoutTrust = merged.filter((r) => (r.critique.trustSignals?.score ?? 0) < 4).map((r) => r.conversionRate);

  const highCtaClarity = merged.filter((r) => (r.critique.ctaClarity?.score ?? 0) >= 4).map((r) => r.conversionRate);
  const lowCtaClarity = merged.filter((r) => (r.critique.ctaClarity?.score ?? 0) < 4).map((r) => r.conversionRate);

  function comparisonLine(label, groupA, labelA, groupB, labelB) {
    const mA = mean(groupA);
    const mB = mean(groupB);
    if (mA === null || mB === null) return `${label}: not enough data in one group to compare.`;
    const diff = mA - mB;
    const relDiff = mB !== 0 ? (diff / mB) * 100 : null;
    return `${label}: ${labelA} average ${fmtPct(mA)} (n=${groupA.length}) vs. ${labelB} average ${fmtPct(mB)} (n=${groupB.length})` +
      (relDiff !== null ? ` — ${relDiff >= 0 ? "+" : ""}${relDiff.toFixed(0)}% relative difference.` : ".");
  }

  const patterns = [
    comparisonLine("CTA/form above the fold (desktop)", withFold, "above fold", withoutFold, "not above fold"),
    comparisonLine("Copy length", shorterCopy, "shorter-copy half", longerCopy, "longer-copy half"),
    comparisonLine("Trust signals (AI score ≥4/5)", withTrust, "strong trust signals", withoutTrust, "weak/no trust signals"),
    comparisonLine("CTA clarity (AI score ≥4/5)", highCtaClarity, "clear CTA", lowCtaClarity, "unclear CTA"),
  ];

  // Every run gets its own permanent, timestamped copy under
  // site/report/runs/<runId>/ so a new analysis never erases an older one.
  // site/report/index.html is always a copy of the newest run (stable
  // bookmarkable URL); site/report/history.html lists every run.
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join("site", "report", "runs", runId);
  mkdirSync(path.join(runDir, "screenshots"), { recursive: true });

  for (const r of merged) {
    for (const key of ["desktopScreenshot", "mobileScreenshot"]) {
      if (r[key] && existsSync(path.join("screenshots", r[key]))) {
        copyFileSync(path.join("screenshots", r[key]), path.join(runDir, "screenshots", r[key]));
      }
    }
  }

  const csv = buildCsv(merged);
  writeFileSync(path.join(runDir, "export.csv"), csv);

  // ZIP bundles duplicate the screenshots a second time (once loose, once
  // compressed). That's fine for a small test batch but adds up fast at
  // scale - a 100+ page run can already be several hundred MB of loose
  // screenshots, so skip the extra copy past this size.
  const ZIP_MAX_PAGES = 20;
  const zipPath = path.join("site", "report", "runs", `${runId}.zip`);
  const zipOk = merged.length <= ZIP_MAX_PAGES ? buildZip(runDir, zipPath) : false;
  if (merged.length > ZIP_MAX_PAGES) {
    console.log(`Skipping ZIP bundle: ${merged.length} pages exceeds ${ZIP_MAX_PAGES} (avoids duplicating screenshots again). Browse/download screenshots individually from the report instead.`);
  }

  const html = buildHtml(merged, patterns, {
    runId,
    historyHref: "../../history.html",
    csvHref: "export.csv",
    zipHref: zipOk ? `../${runId}.zip` : null,
  });
  writeFileSync(path.join(runDir, "index.html"), html);

  // Update the manifest of all runs (newest first).
  const manifestPath = path.join("site", "report", "manifest.json");
  const manifest = loadJson(manifestPath, []);
  manifest.unshift({ runId, generatedAt: new Date().toISOString(), pageCount: merged.length });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // site/report/index.html is the stable bookmarkable URL for "the latest
  // report" - but it's just HTML pointing at this run's own screenshots/
  // (runs/<runId>/screenshots/...), not a second copy of the images. Only
  // the run archive itself stores screenshots, so each page's images exist
  // exactly once in the repo no matter how many times you re-run this.
  const latestHtml = buildHtml(merged, patterns, {
    runId,
    historyHref: "history.html",
    csvHref: "export.csv",
    zipHref: zipOk ? `runs/${runId}.zip` : null,
    screenshotsBase: `runs/${runId}/screenshots/`,
  });
  writeFileSync("site/report/index.html", latestHtml);
  writeFileSync("site/report/export.csv", csv);

  writeFileSync("site/report/history.html", buildHistoryHtml(manifest));

  console.log(`Report written to site/report/index.html and site/report/runs/${runId}/ (${merged.length} pages)`);
  console.log(`CSV export: site/report/export.csv`);
  console.log(zipOk ? `ZIP bundle (report + screenshots): site/report/runs/${runId}.zip` : `ZIP bundle skipped`);
  console.log(`History page: site/report/history.html (${manifest.length} runs total)`);
}

function scoreBar(score) {
  const s = score ?? 0;
  return `<span class="score-bar" title="${s}/5"><span class="score-fill" style="width:${(s / 5) * 100}%"></span></span> ${s}/5`;
}

function pageCard(r, rank, screenshotsBase) {
  const c = r.critique;
  return `
<div class="page-card">
  <div class="page-header">
    <h3>#${rank} ${escapeHtml(r.pageName)}</h3>
    <div class="metrics">
      <span class="metric"><strong>${fmtPct(r.conversionRate)}</strong> conv. rate</span>
      <span class="metric">${r.totalSessions ?? "n/a"} sessions</span>
      <span class="metric">${r.totalConversions ?? "n/a"} conversions</span>
    </div>
    <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.url)}</a>
  </div>
  <div class="page-body">
    <div class="screenshots">
      ${r.desktopScreenshot ? `<a href="${screenshotsBase}${escapeHtml(r.desktopScreenshot)}" target="_blank"><img src="${screenshotsBase}${escapeHtml(r.desktopScreenshot)}" alt="Desktop screenshot" class="shot desktop"></a>` : ""}
      ${r.mobileScreenshot ? `<a href="${screenshotsBase}${escapeHtml(r.mobileScreenshot)}" target="_blank"><img src="${screenshotsBase}${escapeHtml(r.mobileScreenshot)}" alt="Mobile screenshot" class="shot mobile"></a>` : ""}
    </div>
    <div class="critique">
      <table>
        <tr><td>CTA Visibility</td><td>${scoreBar(c.ctaVisibility?.score)}</td><td class="notes">${escapeHtml(c.ctaVisibility?.notes)}</td></tr>
        <tr><td>CTA Clarity</td><td>${scoreBar(c.ctaClarity?.score)}</td><td class="notes">${escapeHtml(c.ctaClarity?.notes)}</td></tr>
        <tr><td>Message Match</td><td>${scoreBar(c.messageMatchPotential?.score)}</td><td class="notes">${escapeHtml(c.messageMatchPotential?.notes)}</td></tr>
        <tr><td>Visual Hierarchy</td><td>${scoreBar(c.visualHierarchy?.score)}</td><td class="notes">${escapeHtml(c.visualHierarchy?.notes)}</td></tr>
        <tr><td>Trust Signals</td><td>${scoreBar(c.trustSignals?.score)}</td><td class="notes">${escapeHtml(c.trustSignals?.notes)}</td></tr>
        <tr><td>Mobile Usability</td><td>${scoreBar(c.mobileUsability?.score)}</td><td class="notes">${escapeHtml(c.mobileUsability?.notes)}</td></tr>
        <tr><td>Copy Scannability</td><td>${scoreBar(c.copyScannability?.score)}</td><td class="notes">${escapeHtml(c.copyScannability?.notes)}</td></tr>
      </table>
      <p><strong>Above fold (desktop / mobile):</strong> ${r.ctaOrFoldDesktop === null ? "n/a" : r.ctaOrFoldDesktop} / ${r.ctaOrFoldMobile === null ? "n/a" : r.ctaOrFoldMobile}</p>
      ${c.brokenOrDated?.found ? `<p class="flag">⚠ Broken/dated: ${escapeHtml(c.brokenOrDated.notes)}</p>` : ""}
      <p><strong>Overall:</strong> ${escapeHtml(c.overallImpression)}</p>
      <p class="recommendation"><strong>Top recommendation:</strong> ${escapeHtml(c.topRecommendation)}</p>
    </div>
  </div>
</div>`;
}

function buildHtml(merged, patterns, { runId, historyHref, csvHref, zipHref, screenshotsBase = "screenshots/" } = {}) {
  const cards = merged.map((r, i) => pageCard(r, i + 1, screenshotsBase)).join("\n");
  const patternsList = patterns.map((p) => `<li>${escapeHtml(p)}</li>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PPC Landing Page Performance Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 0 16px 60px; background: #f7f7f8; color: #1a1a1a; }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { margin-top: 32px; }
  .disclaimer { background: #fff8e1; border: 1px solid #f0d878; border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 14px; }
  .patterns { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px 24px; margin: 20px 0; }
  .patterns li { margin: 8px 0; }
  .page-card { background: #fff; border: 1px solid #ddd; border-radius: 10px; margin: 24px 0; overflow: hidden; }
  .page-header { padding: 16px 20px; border-bottom: 1px solid #eee; background: #fafafa; }
  .page-header h3 { margin: 0 0 8px; }
  .metrics { display: flex; gap: 16px; margin-bottom: 6px; flex-wrap: wrap; }
  .metric { font-size: 14px; color: #444; }
  .page-body { display: flex; flex-wrap: wrap; gap: 20px; padding: 20px; }
  .screenshots { display: flex; gap: 10px; flex-wrap: wrap; }
  .shot { border: 1px solid #ccc; border-radius: 4px; max-height: 320px; object-fit: cover; object-position: top; }
  .shot.desktop { width: 260px; }
  .shot.mobile { width: 110px; }
  .critique { flex: 1; min-width: 320px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  table td { padding: 4px 6px; vertical-align: top; border-bottom: 1px solid #f0f0f0; }
  table td:first-child { white-space: nowrap; font-weight: 600; width: 130px; }
  .notes { color: #555; }
  .score-bar { display: inline-block; width: 60px; height: 8px; background: #eee; border-radius: 4px; overflow: hidden; vertical-align: middle; margin-right: 4px; }
  .score-fill { display: block; height: 100%; background: #4c8bf5; }
  .flag { color: #b02a2a; }
  .recommendation { background: #eef6ff; padding: 8px 10px; border-radius: 6px; }
  a { color: #2b6cb0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>PPC Landing Page Performance Report</h1>
  <p>Generated ${new Date().toISOString()} · ${merged.length} pages · Ranked by Conversion Rate
    ${runId ? ` · Run <code>${escapeHtml(runId)}</code>` : ""}
    ${csvHref ? ` · <a href="${escapeHtml(csvHref)}" download>⬇ Download CSV</a>` : ""}
    ${zipHref ? ` · <a href="${escapeHtml(zipHref)}" download>⬇ Download full report (HTML + images, .zip)</a>` : ""}
    ${historyHref ? ` · <a href="${escapeHtml(historyHref)}">View all past runs →</a>` : ""}
  </p>

  <div class="disclaimer">
    <strong>⚠ Correlation is not causation.</strong> This report compares on-page design/copy signals against
    conversion rate, but conversion rate is also driven by factors invisible on the page itself: traffic source
    quality, keyword intent, ad targeting, and seasonality (which varies significantly per page in the historical
    monthly data). A page that "looks worse" but converts well may simply get higher-intent traffic, and vice versa.
    Use these patterns as hypotheses to test, not proven causes.
  </div>

  <div class="patterns">
    <h2>Observed Patterns</h2>
    <ul>
      ${patternsList}
    </ul>
  </div>

  <h2>Pages (ranked by conversion rate)</h2>
  ${cards}
</div>
</body>
</html>`;
}

function buildHistoryHtml(manifest) {
  const rows = manifest
    .map((m, i) => {
      const label = i === 0 ? " (latest)" : "";
      const dir = i === 0 ? "" : `runs/${escapeHtml(m.runId)}/`;
      const zipPath = path.join("site", "report", "runs", `${m.runId}.zip`);
      const zipCell = existsSync(zipPath)
        ? `<a href="runs/${escapeHtml(m.runId)}.zip" download>⬇ ZIP</a>`
        : "";
      return `<tr><td>${escapeHtml(m.generatedAt)}${label}</td><td>${m.pageCount} pages</td><td><a href="${dir}index.html">Open report →</a></td><td><a href="${dir}export.csv" download>⬇ CSV</a></td><td>${zipCell}</td></tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PPC Analyzer — All Runs</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 0 16px 60px; background: #f7f7f8; color: #1a1a1a; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { margin-top: 32px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #eee; font-size: 14px; }
  th { background: #fafafa; }
  a { color: #2b6cb0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>All Analysis Runs</h1>
  <p><a href="index.html">← Back to latest report</a></p>
  <table>
    <tr><th>Generated</th><th>Pages</th><th></th><th></th><th></th></tr>
    ${rows || '<tr><td colspan="5">No runs yet.</td></tr>'}
  </table>
</div>
</body>
</html>`;
}

run();
