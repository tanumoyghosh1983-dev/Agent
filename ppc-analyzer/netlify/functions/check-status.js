// Netlify Function: check-status.js
// GET /.netlify/functions/check-status
// Returns the latest ppc-analyzer.yml workflow run: status, conclusion,
// per-step progress, and the html_url to view it on GitHub. The frontend
// polls this after triggering a run to show live progress.

const GITHUB_API = "https://api.github.com";

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

async function githubRequest(path) {
  const token = env("GITHUB_TOKEN");
  return fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  try {
    const owner = env("GITHUB_OWNER");
    const repo = env("GITHUB_REPO");
    const branch = env("GITHUB_BRANCH", "claude/feature-recommendations-v0xuna");

    const runsRes = await githubRequest(
      `/repos/${owner}/${repo}/actions/workflows/ppc-analyzer.yml/runs?branch=${encodeURIComponent(branch)}&per_page=1`
    );
    if (!runsRes.ok) {
      const errText = await runsRes.text();
      throw new Error(`Failed to list workflow runs (${runsRes.status}): ${errText}`);
    }
    const runsData = await runsRes.json();
    const run = runsData.workflow_runs && runsData.workflow_runs[0];
    if (!run) {
      return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
    }

    let steps = [];
    if (run.status !== "queued") {
      const jobsRes = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`);
      if (jobsRes.ok) {
        const jobsData = await jobsRes.json();
        const job = jobsData.jobs && jobsData.jobs[0];
        if (job) {
          steps = job.steps.map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion }));
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        found: true,
        runId: run.id,
        status: run.status, // queued | in_progress | completed
        conclusion: run.conclusion, // success | failure | null
        htmlUrl: run.html_url,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        steps,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err && err.message ? err.message : "Failed to check status." }),
    };
  }
};
