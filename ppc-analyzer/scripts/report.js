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

  // --- Copy screenshots into report/ so the HTML is self-contained-ish ---
  mkdirSync("site/report/screenshots", { recursive: true });
  for (const r of merged) {
    for (const key of ["desktopScreenshot", "mobileScreenshot"]) {
      if (r[key] && existsSync(path.join("screenshots", r[key]))) {
        copyFileSync(path.join("screenshots", r[key]), path.join("site", "report", "screenshots", r[key]));
      }
    }
  }

  const html = buildHtml(merged, patterns);
  writeFileSync("site/report/index.html", html);
  console.log(`Report written to site/report/index.html (${merged.length} pages)`);
}

function scoreBar(score) {
  const s = score ?? 0;
  return `<span class="score-bar" title="${s}/5"><span class="score-fill" style="width:${(s / 5) * 100}%"></span></span> ${s}/5`;
}

function pageCard(r, rank) {
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
      ${r.desktopScreenshot ? `<a href="screenshots/${escapeHtml(r.desktopScreenshot)}" target="_blank"><img src="screenshots/${escapeHtml(r.desktopScreenshot)}" alt="Desktop screenshot" class="shot desktop"></a>` : ""}
      ${r.mobileScreenshot ? `<a href="screenshots/${escapeHtml(r.mobileScreenshot)}" target="_blank"><img src="screenshots/${escapeHtml(r.mobileScreenshot)}" alt="Mobile screenshot" class="shot mobile"></a>` : ""}
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

function buildHtml(merged, patterns) {
  const cards = merged.map((r, i) => pageCard(r, i + 1)).join("\n");
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
  <p>Generated ${new Date().toISOString()} · ${merged.length} pages · Ranked by Conversion Rate</p>

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

run();
