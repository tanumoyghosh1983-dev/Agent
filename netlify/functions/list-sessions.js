// Netlify Function: list-sessions.js
// Lists saved interview sessions (from Netlify Blobs) so a reviewer can find
// and re-open a transcript later. GET /list-sessions -> [{id, expert, project, createdAt}]
// GET /list-sessions?id=<id> -> full session record (transcript + audio keys)
// GET /list-sessions?id=<id>&audio=<audioKey> -> raw audio bytes, base64 JSON

const { getStore } = require("@netlify/blobs");

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "GET")
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  try {
    const store = getStore("interview-sessions");
    const params = event.queryStringParameters || {};

    if (params.id && params.audio) {
      const blob = await store.get(params.audio, { type: "arrayBuffer" });
      if (!blob) return { statusCode: 404, headers, body: JSON.stringify({ error: "Audio not found" }) };
      const meta = await store.getMetadata(params.audio);
      return {
        statusCode: 200,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          mimeType: meta?.metadata?.mimeType || "audio/webm",
          audioBase64: Buffer.from(blob).toString("base64"),
        }),
      };
    }

    if (params.id) {
      const record = await store.get(`${params.id}.json`, { type: "json" });
      if (!record) return { statusCode: 404, headers, body: JSON.stringify({ error: "Session not found" }) };
      return { statusCode: 200, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(record) };
    }

    const { blobs } = await store.list();
    const sessions = [];
    for (const b of blobs) {
      if (!b.key.endsWith(".json")) continue;
      const record = await store.get(b.key, { type: "json" });
      if (record) sessions.push({ id: record.id, expert: record.expert, project: record.project, createdAt: record.createdAt });
    }
    sessions.sort((a, c) => (a.createdAt < c.createdAt ? 1 : -1));

    return { statusCode: 200, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(sessions) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err && err.message ? err.message : "Failed to list sessions." }),
    };
  }
};
