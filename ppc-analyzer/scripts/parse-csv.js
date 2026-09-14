// Parses the PPC Dashboard CSV export into a clean array of page records.
//
// The export has two header rows (a merged "month" title row, then the real
// column row) followed by one row per page, and ends with a block of fully
// blank rows. Only the first 8 columns are used: S.No, Page Name, URL,
// Writer, Designer, and the three "Total" metrics (Session, Conversion
// Goals, Conversion Rate %). Everything after column 7 is historical
// month-by-month data, which report.js reads separately for seasonality
// context but which this parser ignores.

import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";

function toNumber(value) {
  if (value === undefined || value === null) return 0;
  const cleaned = String(value).replace(/,/g, "").trim();
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function toPercent(value) {
  if (value === undefined || value === null) return 0;
  const cleaned = String(value).replace(/%/g, "").replace(/,/g, "").trim();
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function parsePpcCsv(csvPath) {
  const raw = readFileSync(csvPath, "utf-8");
  const rows = parse(raw, { relax_column_count: true, skip_empty_lines: false });

  // Row 0 is the merged month-title row, row 1 is the real header row.
  const dataRows = rows.slice(2);

  const pages = [];
  for (const row of dataRows) {
    const pageName = (row[1] || "").trim();
    const url = (row[2] || "").trim();
    if (!pageName || !url) continue; // skip blank/trailing rows

    const totalSessions = toNumber(row[5]);
    const totalConversions = toNumber(row[6]);
    const rawRateCell = (row[7] || "").trim();
    // Source CSV sometimes leaves the Total conversion-rate cell blank even
    // when Session/Goals are populated; fall back to a computed rate rather
    // than silently reporting 0%.
    const conversionRate =
      rawRateCell !== "" ? toPercent(rawRateCell) : totalSessions > 0 ? (totalConversions / totalSessions) * 100 : 0;

    pages.push({
      sNo: (row[0] || "").trim(),
      pageName,
      url,
      writer: (row[3] || "").trim(),
      designer: (row[4] || "").trim(),
      totalSessions,
      totalConversions,
      conversionRate, // percentage points, e.g. 1.57
      conversionRateWasComputed: rawRateCell === "" && totalSessions > 0,
    });
  }

  return pages;
}

// minSessions filters out low-volume pages whose conversion rate is
// statistically meaningless (e.g. 1 session / 5 conversions = 500%).
export function rankPages(pages, minSessions = 100) {
  const reliable = pages.filter((p) => p.totalSessions >= minSessions);

  const byConversionRate = [...reliable].sort((a, b) => b.conversionRate - a.conversionRate);
  const bySessions = [...pages].sort((a, b) => b.totalSessions - a.totalSessions);

  // "High traffic, low conversion": above-median sessions, sorted by worst rate.
  const sessionsSorted = [...pages].sort((a, b) => a.totalSessions - b.totalSessions);
  const medianSessions = sessionsSorted[Math.floor(sessionsSorted.length / 2)]?.totalSessions ?? 0;
  const highTrafficLowConversion = pages
    .filter((p) => p.totalSessions >= medianSessions && p.totalSessions > 0)
    .sort((a, b) => a.conversionRate - b.conversionRate);

  return { byConversionRate, bySessions, highTrafficLowConversion, reliable };
}
