// Netlify Function: save-deal.js
// Stores a complete "deal" — the generated prototype plus whatever else the
// funnel has produced so far (the original idea, the estimate, and the
// build-ready spec) — under a short random ID, so the whole thing can be
// reopened as a shareable deal room at /p.html?id=... . This is the record
// the sales team and the prospect both point at.
//
// No API key needed — Netlify Blobs is built into the platform.

const { connectLambda, getStore } = require("@netlify/blobs");

function makeShortId() {
  return (
    Math.random().toString(36).slice(2, 6) +
    Math.random().toString(36).slice(2, 6)
  );
}

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  const prototype = body.prototype;
  if (
    !prototype ||
    !Array.isArray(prototype.screens) ||
    prototype.screens.length === 0
  ) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing or invalid prototype data" }),
    };
  }

  const record = {
    idea: (body.idea || "").toString().slice(0, 2000),
    prototype,
    estimate: body.estimate || null,
    spec: body.spec || null,
    createdAt: new Date().toISOString(),
  };

  const serialized = JSON.stringify(record);
  if (serialized.length > 1_500_000) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Deal data is too large to save" }),
    };
  }

  try {
    connectLambda(event);
    const store = getStore("deals");

    let id;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = makeShortId();
      const existing = await store.get(candidate);
      if (existing === null) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new Error("Could not generate a unique ID");

    await store.setJSON(id, record);

    // Netlify Blobs is eventually consistent — give a freshly-written record
    // a moment to propagate before the share link can be opened.
    await new Promise((resolve) => setTimeout(resolve, 600));

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message || "Failed to save deal" }),
    };
  }
};
