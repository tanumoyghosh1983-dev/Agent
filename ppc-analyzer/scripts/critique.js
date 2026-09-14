#!/usr/bin/env node
// Usage: ANTHROPIC_API_KEY=sk-... node scripts/critique.js [raw/capture-results.json] [--delay 1000]
//
// For each captured page, sends the desktop screenshot (+ mobile screenshot
// if available) plus extracted on-page content to Claude with a vision
// prompt, asking for a structured JSON critique. Results are written to
// raw/critiques.json and one raw/critique-<slug>.json file per page.
//
// Costs real money per API call. Requires ANTHROPIC_API_KEY to be set.
// Run against a small batch first (raw/capture-results.json produced from
// raw/test-batch.json) before scaling up to the full page list.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith("--")) || "raw/capture-results.json";
const delayMs = Number(args[args.indexOf("--delay") + 1]) || 1000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set. This step calls the Claude API and costs money per page.\n" +
      "Set it first, e.g.:\n  export ANTHROPIC_API_KEY=sk-ant-...\nthen re-run this script."
  );
  process.exit(1);
}

const client = new Anthropic();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CRITIQUE_SCHEMA_PROMPT = `You are a conversion-rate-optimization expert reviewing a PPC landing page screenshot.

You will be shown a desktop screenshot (and, if provided, a mobile screenshot) plus extracted on-page text/structure data. Produce a structured critique as JSON ONLY (no prose outside the JSON, no markdown code fences).

Return an object with exactly this shape:
{
  "ctaVisibility": { "score": 1-5, "notes": "..." },
  "ctaClarity": { "score": 1-5, "notes": "..." },
  "messageMatchPotential": { "score": 1-5, "notes": "does the headline suggest a clear, specific offer?" },
  "visualHierarchy": { "score": 1-5, "notes": "..." },
  "trustSignals": { "score": 1-5, "notes": "testimonials, logos, guarantees, certifications present?", "signalsFound": ["..."] },
  "mobileUsability": { "score": 1-5, "notes": "if no mobile screenshot provided, infer from layout and note that it's an estimate" },
  "copyScannability": { "score": 1-5, "notes": "length and scannability of body copy" },
  "brokenOrDated": { "found": true|false, "notes": "anything broken, outdated, or unprofessional-looking" },
  "overallImpression": "1-2 sentence summary",
  "topRecommendation": "single highest-impact change to try"
}

Scores are 1 (poor) to 5 (excellent). Be specific and critical, not generic.`;

async function critiquePage(pageResult) {
  const desktop = pageResult.viewports?.desktop;
  const mobile = pageResult.viewports?.mobile;

  if (!desktop || desktop.error || !desktop.screenshotPath) {
    return { pageName: pageResult.pageName, url: pageResult.url, error: "No usable desktop screenshot to critique" };
  }

  const content = [{ type: "text", text: CRITIQUE_SCHEMA_PROMPT }];

  content.push({ type: "text", text: "Desktop screenshot:" });
  content.push({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: readFileSync(desktop.screenshotPath).toString("base64"),
    },
  });

  if (mobile && !mobile.error && mobile.screenshotPath && existsSync(mobile.screenshotPath)) {
    content.push({ type: "text", text: "Mobile screenshot:" });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: readFileSync(mobile.screenshotPath).toString("base64"),
      },
    });
  }

  const extractedSummary = {
    title: desktop.title,
    h1s: desktop.h1s,
    h2s: desktop.h2s,
    wordCount: desktop.wordCount,
    ctaCount: desktop.ctaCount,
    ctaTexts: desktop.ctaTexts,
    imageCount: desktop.imageCount,
    formCount: desktop.formCount,
    formFieldCount: desktop.formFieldCount,
    ctaOrFormAboveFold: desktop.ctaOrFormAboveFold,
    mobileCtaOrFormAboveFold: mobile && !mobile.error ? mobile.ctaOrFormAboveFold : null,
  };
  content.push({ type: "text", text: `Extracted page data:\n${JSON.stringify(extractedSummary, null, 2)}` });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content }],
    });
  } catch (err) {
    return { pageName: pageResult.pageName, url: pageResult.url, error: `API error: ${err.message}` };
  }

  const textBlock = response.content.find((b) => b.type === "text");
  const rawText = textBlock?.text?.trim() || "";

  let critique;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    critique = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
  } catch (err) {
    return {
      pageName: pageResult.pageName,
      url: pageResult.url,
      error: `Failed to parse JSON critique: ${err.message}`,
      rawResponse: rawText,
    };
  }

  return {
    pageName: pageResult.pageName,
    url: pageResult.url,
    slug: pageResult.slug,
    critique,
    extractedSummary,
    usage: response.usage,
  };
}

async function run() {
  const captureResults = JSON.parse(readFileSync(inputPath, "utf-8"));
  mkdirSync("raw", { recursive: true });

  console.log(`Critiquing ${captureResults.length} pages with model ${MODEL}. This calls the Claude API and costs money.`);

  const results = [];
  for (let i = 0; i < captureResults.length; i++) {
    const pageResult = captureResults[i];
    console.log(`[${i + 1}/${captureResults.length}] Critiquing: ${pageResult.pageName}`);
    try {
      const critique = await critiquePage(pageResult);
      results.push(critique);
      if (critique.error) console.warn(`  ! ${critique.error}`);
      writeFileSync(path.join("raw", `critique-${pageResult.slug || i}.json`), JSON.stringify(critique, null, 2));
    } catch (err) {
      console.error(`  ! Fatal error: ${err.message}`);
      results.push({ pageName: pageResult.pageName, url: pageResult.url, error: String(err.message || err) });
    }
    await sleep(delayMs);
  }

  writeFileSync(path.join("raw", "critiques.json"), JSON.stringify(results, null, 2));
  const okCount = results.filter((r) => !r.error).length;
  console.log(`\nDone. ${okCount}/${results.length} pages critiqued successfully.`);
  console.log(`Results: raw/critiques.json (and per-page raw/critique-<slug>.json)`);
}

run().catch((err) => {
  console.error("Critique batch failed:", err);
  process.exit(1);
});
