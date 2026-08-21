// Netlify Function: generate-doc.js
// Turns a finished interview transcript (question/answer pairs) into either:
//   - "clean" mode: the same Q&A, in the same order, with each answer just
//     grammar-fixed and de-filler'd into a logical, readable paragraph. No
//     restructuring, no new headings beyond the existing questions.
//   - "full" mode: a structured, detailed Markdown documentation draft,
//     reorganized by topic — the fuller "build a real doc from this" output.
// Neither mode touches images/design — this tool is text-only end to end.
//
// If a sessionId is provided, the result is also persisted to Netlify Blobs
// (same "interview-sessions" store as save-session.js) so it can be
// retrieved later instead of only existing in the browser tab.
//
// Uses raw HTTPS against the Anthropic Messages API. Key is server-side only
// (ANTHROPIC_API_KEY). Model defaults to claude-opus-5.

const { openStore } = require("./lib/blob-store");

const FULL_SYSTEM_PROMPT = `You are a technical writer turning an interview transcript with a subject-matter expert into detailed internal documentation about a client project.

You will receive the expert's name, the project name, and a list of {topic, question, answer} entries in the order they were discussed.

Write clear, well-organized Markdown documentation. Rules:
- GROUNDING IS CRITICAL: only include facts, names, numbers, tools, and claims that are actually present in the answers. Never invent details, outcomes, or specifics that weren't said. If something is ambiguous or incomplete in the transcript, say so plainly (e.g. "not specified in the interview") rather than filling the gap.
- Organize by theme/topic, not strictly in transcript order, if that reads better (e.g. group all "technical approach" answers together even if follow-ups were interleaved).
- Use headings, bullet lists, and short paragraphs. Pull out concrete details (names, tools, numbers, dates, decisions, obstacles, workarounds) rather than paraphrasing vaguely.
- Include a short "Open questions / gaps" section at the end listing anything important that the interview didn't cover, if applicable.
- Do not editorialize or add generic filler ("in today's fast-paced world", etc). Stay factual and specific to what was said.

Output ONLY the Markdown document (starting with a top-level heading), no preamble, no code fences.`;

const CLEAN_SYSTEM_PROMPT = `You are cleaning up a raw spoken-word interview transcript into readable text. You are NOT writing a report — keep the exact same question order and the exact same content, just make it read cleanly.

You will receive the expert's name, the project name, and a list of {topic, question, answer} entries in the order they were asked.

For EACH entry, output the question as given, then the answer rewritten as clean, grammatically correct, logically ordered prose — same facts, same meaning, same level of detail, just with filler words ("um", "like", "you know"), false starts, and run-on rambling removed, and grammar/sentence structure fixed.

RULES:
- GROUNDING IS CRITICAL: never add, infer, or embellish any fact, number, name, or claim that wasn't in the original answer. This is a cleanup pass, not a rewrite for content.
- Keep every question in its original order — do not reorganize, merge, or reorder entries by topic.
- Do not add section headings, summaries, or commentary beyond the Q&A itself.
- If an answer was very short or a non-answer, keep it short — do not pad it out.

Output ONLY Markdown in this exact repeating shape, no preamble:

### [topic]
**Q:** question text
**A:** cleaned answer text
`;

async function callClaude(apiKey, model, expert, project, qa, mode) {
  const transcript = qa
    .map((item, i) => `### Q${i + 1} [${item.topic || "general"}]\nQ: ${item.question}\nA: ${item.answerText}`)
    .join("\n\n");

  const systemPrompt = mode === "clean" ? CLEAN_SYSTEM_PROMPT : FULL_SYSTEM_PROMPT;
  const instruction = mode === "clean" ? "Clean up the transcript." : "Write the documentation.";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 6000,
      output_config: { effort: "medium" },
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Expert: ${expert}\nProject: ${project}\n\nTranscript:\n\n${transcript}\n\n${instruction}`,
        },
      ],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || "Anthropic request failed");
    err.statusCode = res.status;
    throw err;
  }
  if (data.stop_reason === "refusal") {
    throw new Error("The documentation step was declined for this input.");
  }
  const block = (data.content || []).find((b) => b.type === "text");
  const text = block ? block.text : "";
  if (!text) throw new Error("Claude returned an empty response");
  return text;
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY. Set it in Netlify site environment variables." }),
    };
  }

  let expert, project, qa, mode, sessionId;
  try {
    const body = JSON.parse(event.body || "{}");
    expert = String(body.expert || "the expert").slice(0, 160);
    project = String(body.project || "the project").slice(0, 160);
    mode = body.mode === "clean" ? "clean" : "full";
    sessionId = body.sessionId ? String(body.sessionId).slice(0, 100) : null;
    qa = Array.isArray(body.qa)
      ? body.qa.slice(0, 60).map((q) => ({
          topic: String(q.topic || "").slice(0, 200),
          question: String(q.question || "").slice(0, 500),
          answerText: String(q.answerText || "").slice(0, 4000),
        }))
      : [];
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }
  if (!qa.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "No transcript provided." }) };
  }

  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5";

  try {
    const markdown = await callClaude(apiKey, model, expert, project, qa, mode);

    if (sessionId) {
      try {
        const store = openStore();
        await store.set(`${sessionId}-doc-${mode}.md`, markdown);
      } catch (e) {
        // Non-fatal: the browser still has the markdown and can download it,
        // even if persisting it to storage failed for some reason.
      }
    }

    return { statusCode: 200, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ markdown }) };
  } catch (err) {
    return { statusCode: err.statusCode || 502, headers, body: JSON.stringify({ error: err.message || "Failed to generate documentation." }) };
  }
};
