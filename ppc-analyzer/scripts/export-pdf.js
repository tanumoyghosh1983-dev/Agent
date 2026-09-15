#!/usr/bin/env node
// Usage: node scripts/export-pdf.js <path-to-report-dir> [options]
//
// Turns a generated report (a folder containing index.html + screenshots/,
// e.g. site/report/runs/<runId>/, or an unzipped ppc-analyzer-full-report-zip
// download) into compressed PDF(s) you can actually upload to ChatGPT/Claude.
// Full-resolution screenshots are far too large to fit upload limits at any
// real page count, so this:
//   1. Downscales + recompresses every screenshot with sharp (JPEG)
//   2. Inlines the compressed images as base64 data URIs into a temp copy
//      of the report HTML (self-contained, no relative-path issues)
//   3. Renders that HTML to PDF with Playwright/Chromium (prints exactly
//      what the live report shows - tables, scores, images, everything)
//
// Options:
//   --out <path>        output path for a single PDF (default: report.pdf)
//   --chunks N           split into N roughly-equal PDFs instead of one -
//                         useful when even the compressed single PDF is
//                         still too big to upload
//   --out-prefix <path>  base path for chunk files when --chunks is used
//                         (writes <prefix>-part1-of-N.pdf, etc.; default: report)
//   --max-width N        downscale images to this max width in px (default 800)
//   --quality N           JPEG quality 1-100 (default 70)
//
// Tune --max-width / --quality down further (and/or add --chunks) if the
// result is still too big for your target upload limit.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
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
const outPrefix = flag("out-prefix", "report");
const chunks = Number(flag("chunks", "0")); // 0 = single file, no splitting
const maxWidth = Number(flag("max-width", "800"));
const quality = Number(flag("quality", "70"));

if (!reportDir || !existsSync(path.join(reportDir, "index.html"))) {
  console.error(
    "Usage: node scripts/export-pdf.js <path-to-report-dir> [--out report.pdf | --chunks N --out-prefix report] [--max-width 800] [--quality 70]\n" +
      "  <path-to-report-dir> must contain index.html and a screenshots/ folder\n" +
      "  (e.g. site/report/runs/<runId>/, or an unzipped ppc-analyzer-full-report-zip download)."
  );
  process.exit(1);
}

const HEAD_MARKER = '<h2>Pages (ranked by conversion rate)</h2>';
const TAIL = "</div>\n</body>\n</html>";
const CARD_MARKER = '<div class="page-card">';

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

function splitFromDoc(name, requiredValue, message) {
  if (!requiredValue) throw new Error(`${name}: ${message} - report.js's HTML template may have changed.`);
}

// Splits the (already image-inlined) report HTML into an array of
// self-contained "page-card" HTML fragments, plus the shared head (title,
// styles, disclaimer, patterns) and tail to wrap around any subset of them.
function splitIntoCards(html) {
  const headEndIdx = html.indexOf(HEAD_MARKER);
  splitFromDoc("headEndIdx", headEndIdx !== -1, "couldn't find the pages heading");
  const head = html.slice(0, headEndIdx + HEAD_MARKER.length);

  let rest = html.slice(headEndIdx + HEAD_MARKER.length);
  splitFromDoc("tail", rest.endsWith(TAIL), "unexpected document ending");
  rest = rest.slice(0, -TAIL.length);

  const cards = rest
    .split(CARD_MARKER)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => CARD_MARKER + s);

  return { head, cards, tail: TAIL };
}

function chunkArray(arr, n) {
  const size = Math.ceil(arr.length / n);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function renderPdf(browser, html, destPath) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "ppc-pdf-"));
  const tmpHtmlPath = path.join(tmpDir, "report.html");
  writeFileSync(tmpHtmlPath, html);

  mkdirSync(path.dirname(destPath), { recursive: true });
  const page = await browser.newPage();
  await page.goto(`file://${tmpHtmlPath}`, { waitUntil: "load", timeout: 120000 });
  await page.pdf({
    path: destPath,
    format: "A4",
    printBackground: true,
    margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
  });
  await page.close();
  rmSync(tmpDir, { recursive: true, force: true });

  return (readFileSync(destPath).length / 1024 / 1024).toFixed(1);
}

async function run() {
  console.log(`Reading report from ${reportDir} ...`);
  let html = readFileSync(path.join(reportDir, "index.html"), "utf-8");

  const refs = [...new Set([...html.matchAll(/screenshots\/([^"]+\.png)/g)].map((m) => m[1]))];
  console.log(`Found ${refs.length} screenshot references. Compressing (max-width ${maxWidth}px, JPEG q${quality}) ...`);

  const cache = new Map();
  let done = 0;
  for (const file of refs) {
    const imgPath = path.join(reportDir, "screenshots", file);
    const uri = await compressToDataUri(imgPath, cache);
    done++;
    if (done % 20 === 0 || done === refs.length) console.log(`  ${done}/${refs.length} compressed`);
    if (uri) html = html.split(`screenshots/${file}`).join(uri);
  }

  const browser = await chromium.launch();
  const sizes = [];

  if (chunks > 0) {
    const { head, cards, tail } = splitIntoCards(html);
    const effectiveChunks = Math.max(1, Math.min(chunks, cards.length));
    const groups = chunkArray(cards, effectiveChunks);
    console.log(`Splitting ${cards.length} pages into ${groups.length} PDF(s) ...`);
    for (let i = 0; i < groups.length; i++) {
      const partHtml = `${head}\n<p><em>Part ${i + 1} of ${groups.length}</em></p>\n${groups[i].join("\n")}\n${tail}`;
      const destPath = `${outPrefix}-part${i + 1}-of-${groups.length}.pdf`;
      console.log(`Rendering part ${i + 1}/${groups.length} (${groups[i].length} pages) ...`);
      const sizeMb = await renderPdf(browser, partHtml, destPath);
      sizes.push([destPath, sizeMb]);
    }
  } else {
    console.log("Rendering PDF with headless Chromium ...");
    const sizeMb = await renderPdf(browser, html, outPath);
    sizes.push([outPath, sizeMb]);
  }

  await browser.close();

  console.log(`\nDone.`);
  for (const [p, sizeMb] of sizes) {
    console.log(`  ${p} (${sizeMb} MB)`);
    if (Number(sizeMb) > 30) {
      console.log(
        `    Still large for most AI chat upload limits (~20-30MB). Try a smaller --max-width, lower --quality, and/or more --chunks.`
      );
    }
  }
}

run().catch((err) => {
  console.error("PDF export failed:", err);
  process.exit(1);
});
