// Netlify Function: generate-doc.js
// Turns a finished interview transcript (question/answer pairs) into either:
//   - "clean" mode ("Raw transcript" in the UI): the same Q&A, in the same
//     order, with each answer just grammar-fixed and de-filler'd into a
//     logical paragraph. Still visibly Q&A. No restructuring.
//   - "full" mode ("Case study" in the UI): a flowing narrative case study
//     article — no questions, no Q&A structure, written as connected prose
//     organized the way a real case study reads (client context, the
//     challenge, the solution, the outcome), built entirely from the
//     answers' content.
// Neither mode touches images/design — this tool is text-only end to end.
//
// If a sessionId is provided, the result is also persisted to Netlify Blobs
// (same "interview-sessions" store as save-session.js) so it can be
// retrieved later instead of only existing in the browser tab.
//
// Uses raw HTTPS against the Anthropic Messages API. Key is server-side only
// (ANTHROPIC_API_KEY). Model defaults to claude-opus-5.

const { openStore } = require("./lib/blob-store");

const FULL_SYSTEM_PROMPT = `You are a case study writer turning an interview transcript with a subject-matter expert into a polished, narrative case study about a client project — the kind of write-up a real company would publish or keep as an internal case study, not a Q&A record.

You will receive the expert's name, the project name, and a list of {topic, question, answer} entries in the order they were discussed during the interview.

WRITE A NARRATIVE, NOT A TRANSCRIPT:
- Do NOT reproduce the interview questions anywhere in the output, and do NOT structure the piece as Q&A. Weave everything the expert said into connected, flowing prose, the way a published case study reads.
- Organize it the way a real case study is structured, using whichever of these sections the material actually supports: a short client/context overview, the challenge/problem, the approach or solution, and the outcome/impact. Use clear Markdown headings for these sections.
- It is fine — expected, even — to use natural connective and framing language that a case study normally has (e.g. "Faced with this challenge, the team...", "The result was...") even though the expert never said those exact words. That is normal case-study prose, not fabrication.

GROUNDING IS STILL CRITICAL — the line not to cross:
- Every FACT, NAME, NUMBER, TOOL, DECISION, or CLAIM about what actually happened must come from the transcript. Never invent a metric, outcome, technology, date, or specific claim that wasn't said.
- Connective narrative framing (see above) is fine; fabricated content is not. If the transcript is genuinely thin on a section (e.g. no measurable results were given), write that section honestly and briefly from what little exists rather than inventing numbers or outcomes to fill it out.
- Do not use generic marketing filler unrelated to this specific project ("in today's fast-paced world", "cutting-edge solution", etc).

GAP FLAGGING — only if genuinely warranted: if, after writing the case study, there's a real, material gap this single expert plainly couldn't have filled (e.g. the whole technical architecture is described secondhand because this expert was the PM, not the engineer; or the client's own reaction is never described because this expert never spoke with the client directly), add ONE final section "## Suggested Next Interview" — 1-3 short bullet points naming specifically what's missing and what kind of role would likely know it (e.g. "- The backend architecture decisions are described secondhand — worth a short interview with the engineer who owned that piece to get the technical reasoning firsthand."). Do NOT add this section if the case study is already reasonably complete — an empty or forced version of this section is worse than omitting it.

Output ONLY the Markdown case study (starting with a title as a top-level heading), no preamble, no code fences, no questions anywhere in the text.`;

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
  const instruction = mode === "clean" ? "Clean up the transcript." : "Write the narrative case study.";

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

        // Flip the "has a case study" flag on the session record so the
        // Dashboard/Archive can tell which sessions still need one.
        if (mode === "full") {
          const record = await store.get(`${sessionId}.json`, { type: "json" });
          if (record && !record.hasCaseStudy) {
            record.hasCaseStudy = true;
            await store.setJSON(`${sessionId}.json`, record);
          }
        }
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
