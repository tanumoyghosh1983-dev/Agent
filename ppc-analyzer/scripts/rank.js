#!/usr/bin/env node
// Usage: node scripts/rank.js [path/to/PPC_Dashboard_Report.csv] [--top N]
//
// Parses the CSV and prints ranked tables (by conversion rate, by session
// volume, and high-traffic/low-conversion) to the terminal, plus writes the
// full parsed + ranked dataset to raw/pages.json for downstream steps.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parsePpcCsv, rankPages } from "./parse-csv.js";

const args = process.argv.slice(2);
const topFlagIdx = args.indexOf("--top");
const topN = topFlagIdx !== -1 ? Number(args[topFlagIdx + 1]) : 5;
const minFlagIdx = args.indexOf("--min-sessions");
const minSessions = minFlagIdx !== -1 ? Number(args[minFlagIdx + 1]) : 100;
const minRateFlagIdx = args.indexOf("--min-conversion-rate");
const minConversionRate = minRateFlagIdx !== -1 ? Number(args[minRateFlagIdx + 1]) : 0;
const csvArg = args.find(
  (a) => !a.startsWith("--") && a !== String(topN) && a !== String(minSessions) && a !== String(minConversionRate)
);
const csvPath = csvArg || "data/PPC_Dashboard_Report.csv";

const pages = parsePpcCsv(csvPath);
const { byConversionRate, bySessions, highTrafficLowConversion, reliable } = rankPages(pages, minSessions);

function printTable(title, rows) {
  console.log(`\n=== ${title} ===`);
  console.log(
    "Rank | Page Name".padEnd(45) + "Sessions".padStart(10) + "  Conv".padStart(8) + "  Rate%".padStart(8)
  );
  rows.forEach((p, i) => {
    console.log(
      `${String(i + 1).padStart(4)} | ${p.pageName.slice(0, 38).padEnd(38)}` +
        `${String(p.totalSessions).padStart(10)}` +
        `${String(p.totalConversions).padStart(8)}` +
        `${p.conversionRate.toFixed(2).padStart(8)}%`
    );
    console.log(`       ${p.url}`);
  });
}

console.log(`Parsed ${pages.length} pages from ${csvPath}`);
console.log(`${reliable.length} pages have >= ${minSessions} sessions (used for conversion-rate ranking)`);

printTable(`Top ${topN} by Conversion Rate (min ${minSessions} sessions)`, byConversionRate.slice(0, topN));
printTable(`Bottom ${topN} by Conversion Rate (min ${minSessions} sessions)`, [...byConversionRate].reverse().slice(0, topN));
printTable(`Top ${topN} by Session Volume`, bySessions.slice(0, topN));
printTable(`Top ${topN} High-Traffic / Low-Conversion`, highTrafficLowConversion.slice(0, topN));

mkdirSync("raw", { recursive: true });
writeFileSync(
  path.join("raw", "pages.json"),
  JSON.stringify({ pages, minSessions, rankings: { byConversionRate, bySessions, highTrafficLowConversion } }, null, 2)
);
console.log(`\nFull parsed + ranked dataset written to raw/pages.json`);

// Suggested test batch: top N + bottom N by conversion rate (reliable pages only).
const testBatch =
  topN * 2 >= byConversionRate.length
    ? byConversionRate
    : [...byConversionRate.slice(0, topN), ...byConversionRate.slice(-topN)];
writeFileSync(path.join("raw", "test-batch.json"), JSON.stringify(testBatch, null, 2));
console.log(`Suggested test batch (top ${topN} + bottom ${topN}, min ${minSessions} sessions) written to raw/test-batch.json`);

// Threshold batch: every reliable page at or above a minimum conversion rate,
// for "analyze everything that's actually converting decently" runs.
const thresholdBatch = byConversionRate.filter((p) => p.conversionRate >= minConversionRate);
writeFileSync(path.join("raw", "threshold-batch.json"), JSON.stringify(thresholdBatch, null, 2));
console.log(
  `${thresholdBatch.length} pages with >= ${minConversionRate}% conversion rate (and >= ${minSessions} sessions) written to raw/threshold-batch.json`
);
