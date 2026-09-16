// Netlify Function: trigger-analysis.js
// POST body (JSON): { password, csvContent, csvFilename, topN, minSessions, scope }
// 1. Checks the shared app password (APP_ACCESS_PASSWORD env var) so a
//    public Netlify URL can't be used by strangers to spend your Claude
//    API budget or spam your repo with commits.
// 2. Commits the uploaded CSV to the repo (GitHub Contents API).
// 3. Triggers the ppc-analyzer.yml GitHub Actions workflow (workflow_dispatch).
//
// Requires env vars on the Netlify site: GITHUB_TOKEN (repo + workflow
// scopes), GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, APP_ACCESS_PASSWORD.

const GITHUB_API = "https://api.github.com";

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

async function githubRequest(path, options = {}) {
  const token = env("GITHUB_TOKEN");
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return res;
}

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const appPassword = process.env.APP_ACCESS_PASSWORD;
  if (appPassword && body.password !== appPassword) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Incorrect password" }) };
  }

  const { csvContent, topN, minSessions, scope, minConversionRate, maxConversionRate } = body;
  if (!csvContent || typeof csvContent !== "string") {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "csvContent is required" }) };
  }

  try {
    const owner = env("GITHUB_OWNER");
    const repo = env("GITHUB_REPO");
    const branch = env("GITHUB_BRANCH", "claude/feature-recommendations-v0xuna");
    const csvPath = "ppc-analyzer/data/PPC_Dashboard_Report.csv";

    // 1. Get the current file SHA (needed to update an existing file), if it exists.
    let sha;
    const getRes = await githubRequest(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(csvPath)}?ref=${encodeURIComponent(branch)}`
    );
    if (getRes.ok) {
      const getData = await getRes.json();
      sha = getData.sha;
    } else if (getRes.status !== 404) {
      const errText = await getRes.text();
      throw new Error(`Failed to read existing CSV (${getRes.status}): ${errText}`);
    }

    // 2. Commit the uploaded CSV.
    const contentBase64 = Buffer.from(csvContent, "utf-8").toString("base64");
    const putRes = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(csvPath)}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Update PPC dashboard CSV via web app (${new Date().toISOString()})`,
        content: contentBase64,
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!putRes.ok) {
      const errText = await putRes.text();
      throw new Error(`Failed to commit CSV (${putRes.status}): ${errText}`);
    }

    // 3. Trigger the workflow.
    const dispatchRes = await githubRequest(
      `/repos/${owner}/${repo}/actions/workflows/ppc-analyzer.yml/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({
          ref: branch,
          inputs: {
            csv_path: "data/PPC_Dashboard_Report.csv",
            top_n: String(topN || 5),
            min_sessions: String(minSessions || 100),
            scope: ["all", "above-threshold"].includes(scope) ? scope : "test-batch",
            min_conversion_rate: String(minConversionRate || 1),
            max_conversion_rate: maxConversionRate ? String(maxConversionRate) : "",
          },
        }),
      }
    );
    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text();
      throw new Error(`Failed to trigger workflow (${dispatchRes.status}): ${errText}`);
    }

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        message: "CSV committed and analysis started.",
        actionsUrl: `https://github.com/${owner}/${repo}/actions/workflows/ppc-analyzer.yml`,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err && err.message ? err.message : "Failed to start analysis." }),
    };
  }
};
