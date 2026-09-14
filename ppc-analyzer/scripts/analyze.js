#!/usr/bin/env node
// Usage: node scripts/analyze.js path/to/PPC_Dashboard_Report.csv [options]
//
// Runs the full pipeline: rank -> capture -> critique -> report.
// Pauses before the critique step (the one that costs money) unless
// --yes is passed, since it calls the Claude API once per page.
//
// Options:
//   --top N            top/bottom N pages per ranking category (default 5)
//   --min-sessions N    minimum sessions for reliable conversion-rate ranking (default 100)
//   --all               run against the full page list instead of just the top/bottom test batch
//   --yes               skip the cost confirmation prompt before the critique step
//   --concurrency N     browser capture concurrency (default 2)
//   --delay N           delay in ms between requests, for both capture and critique (default 1500)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith("--"));
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

if (!csvPath) {
  console.error("Usage: node scripts/analyze.js path/to/PPC_Dashboard_Report.csv [--top N] [--min-sessions N] [--all] [--yes]");
  process.exit(1);
}

const topN = flag("top", "5");
const minSessions = flag("min-sessions", "100");
const useAll = has("all");
const concurrency = flag("concurrency", "2");
const delay = flag("delay", "1500");

function run(cmd, cmdArgs) {
  console.log(`\n> node ${cmd} ${cmdArgs.join(" ")}`);
  execFileSync("node", [cmd, ...cmdArgs], { stdio: "inherit" });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  run("scripts/rank.js", [csvPath, "--top", topN, "--min-sessions", minSessions]);

  const batchInput = useAll ? "raw/pages.json" : "raw/test-batch.json";
  const batch = JSON.parse(readFileSync("raw/pages.json", "utf-8"));
  const pageCount = useAll ? batch.pages.length : Math.min(2 * Number(topN), batch.pages.length);
  console.log(`\nCapture batch: ${useAll ? "ALL pages" : "test batch (top+bottom by conversion rate)"} (~${pageCount} pages)`);

  run("scripts/capture.js", [batchInput, "--concurrency", concurrency, "--delay", delay]);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "\nANTHROPIC_API_KEY is not set. Capture is done (screenshots + extracted data saved).\n" +
        "Set the API key and re-run `npm run critique` and `npm run report` to continue with the AI critique step."
    );
    process.exit(0);
  }

  if (!has("yes")) {
    const answer = await ask(
      `\nAbout to critique ~${pageCount} pages with Claude (vision + text). This calls the Claude API and costs money.\n` +
        `Continue? [y/N] `
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Stopped before the critique step. Re-run with --yes to skip this prompt next time.");
      process.exit(0);
    }
  }

  run("scripts/critique.js", ["raw/capture-results.json", "--delay", delay]);
  run("scripts/report.js", []);

  console.log(`\nDone. Open report/index.html to view the report.`);
}

main().catch((err) => {
  console.error("Pipeline failed:", err.message);
  process.exit(1);
});
