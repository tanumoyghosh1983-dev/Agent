#!/usr/bin/env node
// Usage: node scripts/capture.js [raw/test-batch.json] [--concurrency 2] [--delay 1500]
//
// For each page in the input JSON (an array of {pageName, url, ...}), loads
// the URL at desktop (1440x900) and mobile (390x844) viewports, takes
// full-page screenshots, extracts on-page content signals, and measures
// load time. Errors (404s, timeouts, redirects) are caught per-page and
// logged rather than crashing the batch. Rate-limited via a delay between
// requests plus a concurrency cap so we don't hammer the live site.

import { chromium } from "playwright";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith("--")) || "raw/test-batch.json";
const concurrency = Number(args[args.indexOf("--concurrency") + 1]) || 2;
const delayMs = Number(args[args.indexOf("--delay") + 1]) || 1500;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractPageData(page) {
  return page.evaluate(() => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    const title = document.title || "";
    const h1s = Array.from(document.querySelectorAll("h1")).filter(isVisible).map((el) => el.innerText.trim());
    const h2s = Array.from(document.querySelectorAll("h2")).filter(isVisible).map((el) => el.innerText.trim());

    const bodyText = document.body ? document.body.innerText.trim() : "";
    const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;

    // CTA heuristic: buttons, links styled as buttons, and submit inputs.
    const ctaSelectors = 'button, a.btn, a[class*="button"], a[class*="cta"], input[type="submit"], input[type="button"]';
    const ctaEls = Array.from(document.querySelectorAll(ctaSelectors)).filter(isVisible);
    const ctaTexts = ctaEls.map((el) => (el.innerText || el.value || "").trim()).filter(Boolean);

    const images = Array.from(document.querySelectorAll("img")).filter(isVisible);
    const imageData = images.map((img) => ({
      src: img.currentSrc || img.src || "",
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0,
    }));

    const forms = Array.from(document.querySelectorAll("form"));
    const formFieldCount = forms.reduce(
      (sum, f) => sum + f.querySelectorAll("input, select, textarea").length,
      0
    );

    // Above-the-fold check: any CTA or form element within the first viewport height.
    const viewportHeight = window.innerHeight;
    const aboveFoldCandidates = [...ctaEls, ...forms];
    const ctaOrFormAboveFold = aboveFoldCandidates.some((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.top < viewportHeight;
    });

    return {
      title,
      h1s,
      h2s,
      wordCount,
      bodyTextSample: bodyText.slice(0, 4000),
      ctaCount: ctaEls.length,
      ctaTexts: [...new Set(ctaTexts)].slice(0, 15),
      imageCount: imageData.length,
      images: imageData.slice(0, 30),
      formCount: forms.length,
      formFieldCount,
      ctaOrFormAboveFold,
    };
  });
}

async function capturePage(browser, pageRecord, outDir) {
  const slug = slugify(pageRecord.pageName || pageRecord.url);
  const result = {
    pageName: pageRecord.pageName,
    url: pageRecord.url,
    slug,
    capturedAt: new Date().toISOString(),
    viewports: {},
    error: null,
  };

  for (const [viewportName, viewportSize] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport: viewportSize, userAgent: undefined });
    const page = await context.newPage();
    try {
      const start = Date.now();
      const response = await page.goto(pageRecord.url, { waitUntil: "load", timeout: 30000 });
      const loadTimeMs = Date.now() - start;
      const status = response ? response.status() : null;
      const finalUrl = page.url();

      if (!response || status >= 400) {
        result.viewports[viewportName] = { error: `HTTP ${status ?? "no response"}`, loadTimeMs, finalUrl };
        continue;
      }

      await page.waitForTimeout(500); // let above-fold layout settle

      // Claude's vision API rejects images with a dimension over 8000px.
      // Very long landing pages can exceed that with a full-page screenshot,
      // so clip to the max instead of failing the critique step later.
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const MAX_SCREENSHOT_HEIGHT = 8000;

      const screenshotPath = path.join(outDir, `${slug}-${viewportName}.png`);
      if (pageHeight > MAX_SCREENSHOT_HEIGHT) {
        await page.screenshot({
          path: screenshotPath,
          clip: { x: 0, y: 0, width: viewportSize.width, height: MAX_SCREENSHOT_HEIGHT },
        });
      } else {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }

      const extracted = await extractPageData(page);

      result.viewports[viewportName] = {
        loadTimeMs,
        status,
        redirected: finalUrl !== pageRecord.url,
        finalUrl,
        screenshotPath,
        ...extracted,
      };
    } catch (err) {
      result.viewports[viewportName] = { error: String(err.message || err) };
    } finally {
      await context.close();
    }
  }

  return result;
}

async function run() {
  const input = JSON.parse(readFileSync(inputPath, "utf-8"));
  const pages = Array.isArray(input) ? input : input.pages;

  mkdirSync("screenshots", { recursive: true });
  mkdirSync("raw", { recursive: true });

  const browser = await chromium.launch();
  const results = [];
  const errors = [];

  // Simple concurrency-limited queue with a delay between launches to
  // avoid hammering the site or tripping bot protection.
  let index = 0;
  async function worker() {
    while (index < pages.length) {
      const myIndex = index++;
      const pageRecord = pages[myIndex];
      console.log(`[${myIndex + 1}/${pages.length}] Capturing: ${pageRecord.pageName} (${pageRecord.url})`);
      try {
        const result = await capturePage(browser, pageRecord, "screenshots");
        results.push(result);
        const failedViewports = Object.entries(result.viewports).filter(([, v]) => v.error);
        if (failedViewports.length) {
          for (const [vp, v] of failedViewports) {
            console.warn(`  ! ${vp} failed: ${v.error}`);
            errors.push({ pageName: pageRecord.pageName, url: pageRecord.url, viewport: vp, error: v.error });
          }
        }
      } catch (err) {
        console.error(`  ! Fatal error on ${pageRecord.url}: ${err.message}`);
        errors.push({ pageName: pageRecord.pageName, url: pageRecord.url, error: String(err.message || err) });
      }
      await sleep(delayMs);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  await browser.close();

  writeFileSync(path.join("raw", "capture-results.json"), JSON.stringify(results, null, 2));
  writeFileSync(path.join("raw", "capture-errors.json"), JSON.stringify(errors, null, 2));

  console.log(`\nDone. ${results.length} pages captured, ${errors.length} viewport/page errors.`);
  console.log(`Results: raw/capture-results.json`);
  console.log(`Errors:  raw/capture-errors.json`);
  console.log(`Screenshots: screenshots/`);
}

run().catch((err) => {
  console.error("Batch capture failed:", err);
  process.exit(1);
});
