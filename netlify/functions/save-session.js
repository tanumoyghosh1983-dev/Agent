// Netlify Function: save-session.js
// Persists one finished interview session (metadata + full Q&A transcript +
// each answer's raw audio, base64-encoded) to Netlify Blobs. Netlify Blobs
// needs no external account or credentials beyond the Netlify site itself,
// which is why it's the default storage backend for this project.
//
// Also auto-tags the session (industries/technologies/outcomes mentioned)
// via a small Claude call so the Archive and Dashboard can search/group by
// more than just client/expert name. Tagging is best-effort — if it fails
// or ANTHROPIC_API_KEY is missing, the session still saves fine, just
// without auto-tags (any industry/technologies typed in at setup are kept
// either way).
//
// Supports UPDATING an existing session: if the request includes a
// "sessionId" for a record that already exists, that same id is reused
// (instead of minting a new one) and its qa/tags are overwritten with the
// full, updated set the client sends — this is what powers "add more
// information to an interview later" (see interview.html's finish-review
// flow). Any previously generated case study/raw-transcript docs for that
// session are deleted, since they'd now describe stale content, and
// hasCaseStudy resets to false so the Dashboard flags it as needing a
// fresh one.
//
// Stored under two keys per session in the "interview-sessions" store:
//   <id>.json   -> { id, expert, project, createdAt, qa, industry, technologies, tags, hasCaseStudy }
//   <id>/answer-<n>.<ext> -> raw audio bytes for that answer (fetched on demand)

const { openStore } = require("./lib/blob-store");

const TAGGING_SYSTEM_PROMPT = `You extract structured tags from a client-project interview transcript for search/filtering purposes.

Respond with ONLY valid JSON (no markdown fences, no preamble) in exactly this shape:
{
  "industries": ["short industry labels actually implied by the content, e.g. 'Fintech', 'Healthcare', 'Logistics' — empty array if unclear"],
  "technologies": ["specific named technologies/tools/languages/platforms actually mentioned — empty array if none named"],
  "outcomes": ["short phrases for concrete outcomes/results actually mentioned, e.g. '40% faster checkout', 'eliminated manual reconciliation' — empty array if none given"]
}

RULES:
- GROUNDING IS CRITICAL: only include an item if it's genuinely supported by the transcript. Never guess an industry or invent a technology/outcome that wasn't mentioned.
- Keep each entry short (2-5 words). Max 6 items per array.
- Normalize obvious duplicates/variants (e.g. "React.js" and "React" -> just "React").

Output ONLY the JSON object.`;

async function extractTags(apiKey, model, project, qa) {
  const transcript = qa.map((q) => `Q: ${q.question}\nA: ${q.answerText}`).join("\n\n").slice(0, 12000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        output_config: { effort: "low" },
        system: TAGGING_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Project: ${project}\n\nTranscript:\n\n${transcript}\n\nExtract the tags.` }],
      }),
    });
    const data = await res.json();
    if (!res.ok || data.stop_reason === "refusal") return { industries: [], technologies: [], outcomes: [] };
    const block = (data.content || []).find((b) => b.type === "text");
    const raw = (block ? block.text : "").replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(raw);
    const arr = (v) => (Array.isArray(v) ? v.map((s) => String(s).slice(0, 60)).slice(0, 6) : []);
    return { industries: arr(parsed.industries), technologies: arr(parsed.technologies), outcomes: arr(parsed.outcomes) };
  } catch (e) {
    return { industries: [], technologies: [], outcomes: [] };
  }
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
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const expert = String(body.expert || "Unknown expert").slice(0, 160);
  const project = String(body.project || "Untitled project").slice(0, 160);
  const industry = String(body.industry || "").slice(0, 100);
  const technologies = String(body.technologies || "").slice(0, 300);
  const qa = Array.isArray(body.qa) ? body.qa : [];
  const requestedId = body.sessionId ? String(body.sessionId).slice(0, 100) : null;
  if (!qa.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "No questions/answers to save." }) };
  }

  try {
    const store = openStore();

    // If continuing an existing session (more info added after the fact),
    // reuse its id and original createdAt instead of minting a new record.
    let id = requestedId;
    let createdAt = new Date().toISOString();
    let isUpdate = false;
    if (requestedId) {
      const existing = await store.get(`${requestedId}.json`, { type: "json" });
      if (existing) { createdAt = existing.createdAt; isUpdate = true; }
    }
    if (!id) id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

    // Best-effort auto-tagging — never blocks saving if it fails.
    let tags = { industries: [], technologies: [], outcomes: [] };
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      const model = process.env.ANTHROPIC_MODEL || "claude-opus-5";
      tags = await extractTags(anthropicKey, model, project, transcriptQA);
    }
    // Merge in whatever the expert typed at setup, deduped, user's own words first.
    const dedupe = (arr) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
    if (industry) tags.industries = dedupe([industry, ...tags.industries]);
    if (technologies) tags.technologies = dedupe([...technologies.split(","), ...tags.technologies]);

    const record = {
      id, expert, project, createdAt, qa: transcriptQA,
      industry, technologies, tags, hasCaseStudy: false,
    };
    await store.setJSON(`${id}.json`, record);

    if (isUpdate) {
      // The transcript just changed — any previously generated case
      // study/raw-transcript docs now describe stale content. Delete them
      // so the Archive regenerates fresh ones from the updated transcript
      // next time they're opened, instead of silently showing old text.
      try {
        await store.delete(`${id}-doc-clean.md`);
        await store.delete(`${id}-doc-full.md`);
      } catch (e) {
        // Non-fatal — a stale cached doc getting served once is a much
        // smaller problem than failing the save itself.
      }
    }

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ id, createdAt, isUpdate }),
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
