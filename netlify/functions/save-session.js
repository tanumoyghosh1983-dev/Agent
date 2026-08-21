// Netlify Function: save-session.js
// Persists one finished interview session (metadata + full Q&A transcript +
// each answer's raw audio, base64-encoded) to Netlify Blobs. Netlify Blobs
// needs no external account or credentials beyond the Netlify site itself,
// which is why it's the default storage backend for this project.
//
// Stored under two keys per session in the "interview-sessions" store:
//   <id>.json   -> { id, expert, project, createdAt, qa: [...] } (transcript, no audio)
//   <id>/answer-<n>.<ext> -> raw audio bytes for that answer (fetched on demand)

const { openStore } = require("./lib/blob-store");

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
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const expert = String(body.expert || "Unknown expert").slice(0, 160);
  const project = String(body.project || "Untitled project").slice(0, 160);
  const qa = Array.isArray(body.qa) ? body.qa : [];
  if (!qa.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "No questions/answers to save." }) };
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();

  try {
    const store = openStore();

    // Save each answer's audio separately (blobs are for binary, not JSON),
    // and strip the base64 out of the transcript record we index by.
    const transcriptQA = [];
    for (let i = 0; i < qa.length; i++) {
      const item = qa[i];
      const question = String(item.question || "").slice(0, 500);
      const answerText = String(item.answerText || "").slice(0, 8000);
      const topic = String(item.topic || "").slice(0, 200);
      let audioKey = null;

      if (item.audioBase64) {
        const mimeType = String(item.mimeType || "audio/webm");
        const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
        audioKey = `${id}/answer-${i + 1}.${ext}`;
        const audioBuffer = Buffer.from(item.audioBase64, "base64");
        await store.set(audioKey, audioBuffer, { metadata: { mimeType } });
      }

      transcriptQA.push({ topic, question, answerText, audioKey });
    }

    const record = { id, expert, project, createdAt, qa: transcriptQA };
    await store.setJSON(`${id}.json`, record);

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ id, createdAt }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error:
          "Failed to save the session to storage. " +
          (err && err.message ? err.message : "Netlify Blobs may not be enabled for this site yet."),
      }),
    };
  }
};
