// Netlify Function: interview-next-question.js
// The "interviewer" agent, powered by Claude. Given a topic outline and the
// conversation so far (question/answer pairs), decides what to ask next: a
// fresh question for the next uncovered topic, or a follow-up probe digging
// into something the expert just said. This is what turns a flat Q&A script
// into something that pulls out the extra, unscripted detail experts don't
// think to write down themselves.
//
// Uses raw HTTPS against the Anthropic Messages API to match this project's
// zero-dependency serverless-proxy convention. Key is server-side only
// (ANTHROPIC_API_KEY). Model defaults to claude-opus-5.

const SYSTEM_PROMPT = `You are an experienced documentation interviewer, live in a real spoken conversation with a subject-matter expert about a client project. A transcript will be built from this afterward. The expert dislikes writing but is comfortable talking, so your questions have to do the work: concrete, specific, one at a time, easy to answer out loud.

You will be given:
- "outline": topics that should eventually be covered (e.g. "the client and problem", "the technical approach", "obstacles hit", "the outcome/impact"). These are a checklist, not a rigid script - the expert will often answer things out of order or bundle several topics into one answer, the way people actually talk.
- "history": every question already asked and the expert's answer, in order.

STEP 1 - before deciding anything, mentally list every concrete fact, name, tool, number, decision, and event the expert has ALREADY told you, across ALL of history, not just the answer under the topic you're about to ask about. Experts frequently answer a later topic while still talking about an earlier one (e.g. they mention what they built while explaining the original problem). Anything already stated anywhere in history counts as already known, regardless of which question it came up under.

STEP 2 - decide the SINGLE next thing to ask, in this priority order:
1. FOLLOW-UP: if the most recent answer mentioned something specific but underexplored (a tool, a number, a decision, a person, a workaround, a surprising result) that ISN'T already covered elsewhere in history, ask ONE sharp follow-up digging into that specific detail. This is how the extra detail gets captured - prefer it whenever the last answer leaves something concrete and new on the table.
2. NEXT TOPIC: otherwise, look at the outline topics and pick one that still has a real, unanswered gap based on your Step 1 review, not just one whose exact question hasn't been asked yet. If the expert already covered a topic's core content while answering something else, treat that topic as done (or ask only about the specific piece still missing from it) instead of asking its "standard" opening question from scratch.

When every topic is reasonably covered by what's actually in history and there's nothing left worth a follow-up, respond with "done": true instead of a question.

Respond with ONLY valid JSON (no markdown fences, no preamble) in exactly this shape:
{
  "done": false,
  "topic": "the outline topic this question belongs to (verbatim from outline, or 'follow-up' if probing the last answer)",
  "question": "the single next question to ask, written as you would say it out loud, one question only, no preamble like 'Great, next...'"
}

HARD RULES:
- NEVER ask for a fact, name, number, or description that is already present anywhere in history's answers, even in a different topic's answer, even if worded slightly differently. This is the most common mistake - check twice.
- Ask ONE question at a time. Never stack multiple questions in one string.
- Keep questions concrete and answerable from memory: ask for specifics (what, who, when, how, why this and not that) rather than vague prompts like "tell me more".
- Keep the question itself under ~40 words.
- If history is empty, ask a warm, concrete opening question about the FIRST outline topic.

Output ONLY the JSON object.`;

async function callClaude(apiKey, model, outline, history) {
  const userPayload = JSON.stringify({ outline, history }, null, 2);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      // "low" effort was too shallow to reliably cross-check the whole
      // conversation for facts already mentioned under a different topic,
      // which caused repeat/redundant questions. "medium" costs a bit more
      // latency per question but actually reasons about what's known.
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: "Here is the outline and interview history so far. Decide the next question:\n\n" + userPayload,
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
    throw new Error("The interviewer step was declined for this input.");
  }
  const block = (data.content || []).find((b) => b.type === "text");
  const text = block ? block.text : "";
  if (!text) throw new Error("Claude returned an empty response");
  return text;
}

function parseJSON(raw) {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (_) {
        return null;
      }
    }
    return null;
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY. Set it in Netlify site environment variables." }),
    };
  }

  let outline, history;
  try {
    const body = JSON.parse(event.body || "{}");
    outline = Array.isArray(body.outline) ? body.outline.map((t) => String(t).slice(0, 200)).slice(0, 20) : [];
    history = Array.isArray(body.history)
      ? body.history.slice(-30).map((h) => ({
          question: String(h.question || "").slice(0, 500),
          // The browser sends this field as "answerText" (see public/interview.html);
          // accept "answer" too in case a caller uses the more natural name.
          answer: String(h.answerText || h.answer || "").slice(0, 4000),
        }))
      : [];
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }
  if (!outline.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Please provide at least one outline topic." }) };
  }

  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5";

  try {
    const plan = parseJSON(await callClaude(apiKey, model, outline, history));
    if (!plan) throw new Error("The interviewer response didn't come through cleanly. Please try again.");
    const out = plan.done
      ? { done: true }
      : {
          done: false,
          topic: String(plan.topic || "").slice(0, 200),
          question: String(plan.question || "").slice(0, 500),
        };
    if (!out.done && !out.question) throw new Error("No question was generated. Please try again.");
    return { statusCode: 200, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(out) };
  } catch (err) {
    return { statusCode: err.statusCode || 502, headers, body: JSON.stringify({ error: err.message || "Failed to generate the next question." }) };
  }
};
