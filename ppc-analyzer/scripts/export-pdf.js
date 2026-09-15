#!/usr/bin/env node
// Usage: node scripts/export-pdf.js <path-to-report-dir> [--out report.pdf] [--max-width 800] [--quality 70]
//
// Turns a generated report (a folder containing index.html + screenshots/,
// e.g. site/report/runs/<runId>/, or an unzipped ppc-analyzer-full-report-zip
// download) into a single compressed PDF you can actually upload to
// ChatGPT/Claude. Full-resolution screenshots are far too large to fit
// upload limits at any real page count, so this:
//   1. Downscales + recompresses every screenshot with sharp (JPEG)
//   2. Inlines the compressed images as base64 data URIs into a temp copy
//      of the report HTML (self-contained, no relative-path issues)
//   3. Renders that HTML to PDF with Playwright/Chromium (prints exactly
//      what the live report shows - tables, scores, images, everything)
//
// Tune --max-width / --quality down further if the result is still too
// big for your target upload limit.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const reportDir = args.find((a) => !a.startsWith("--"));
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : def;
};
const outPath = flag("out", "report.pdf");
const maxWidth = Number(flag("max-width", "800"));
const quality = Number(flag("quality", "70"));

if (!reportDir || !existsSync(path.join(reportDir, "index.html"))) {
  console.error(
    "Usage: node scripts/export-pdf.js <path-to-report-dir> [--out report.pdf] [--max-width 800] [--quality 70]\n" +
      "  <path-to-report-dir> must contain index.html and a screenshots/ folder\n" +
      "  (e.g. site/report/runs/<runId>/, or an unzipped ppc-analyzer-full-report-zip download)."
  );
  process.exit(1);
}

async function compressToDataUri(imgPath, cache) {
  if (cache.has(imgPath)) return cache.get(imgPath);
  if (!existsSync(imgPath)) return null;
  const buf = await sharp(imgPath)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  const uri = `data:image/jpeg;base64,${buf.toString("base64")}`;
  cache.set(imgPath, uri);
  return uri;
}

async function run() {
  console.log(`Reading report from ${reportDir} ...`);
  let html = readFileSync(path.join(reportDir, "index.html"), "utf-8");

  // Find every screenshots/<file> reference (both href and src use the
  // same relative path in this report's HTML).
  const refs = [...new Set([...html.matchAll(/screenshots\/([^"]+\.png)/g)].map((m) => m[1]))];
  console.log(`Found ${refs.length} screenshot references. Compressing (max-width ${maxWidth}px, JPEG q${quality}) ...`);

  const cache = new Map();
  let done = 0;
  for (const file of refs) {
    const imgPath = path.join(reportDir, "screenshots", file);
    const uri = await compressToDataUri(imgPath, cache);
    done++;
    if (done % 20 === 0 || done === refs.length) console.log(`  ${done}/${refs.length} compressed`);
    if (uri) {
      // Replace both the <img src="screenshots/x.png"> and the
      // <a href="screenshots/x.png"> wrapper with the same inlined data
      // URI - the click-through link becomes a (harmless) self-link.
      html = html.split(`screenshots/${file}`).join(uri);
    }
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "ppc-pdf-"));
  const tmpHtmlPath = path.join(tmpDir, "report.html");
  writeFileSync(tmpHtmlPath, html);

  console.log("Rendering PDF with headless Chromium ...");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${tmpHtmlPath}`, { waitUntil: "load", timeout: 120000 });
  await page.pdf({
    path: outPath,
    format: "A4",
    printBackground: true,
    margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
  });
  await browser.close();
  rmSync(tmpDir, { recursive: true, force: true });

  const sizeMb = (readFileSync(outPath).length / 1024 / 1024).toFixed(1);
  console.log(`\nDone. PDF written to ${outPath} (${sizeMb} MB)`);
  if (Number(sizeMb) > 30) {
    console.log(
      "Still large for most AI chat upload limits (~20-30MB). Try a smaller --max-width (e.g. 500) and/or --quality (e.g. 50), " +
        "or export a filtered subset of pages instead of the full report."
    );
  }
}

run().catch((err) => {
  console.error("PDF export failed:", err);
  process.exit(1);
});
