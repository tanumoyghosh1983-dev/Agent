// Netlify Function: interview-next-question.js
// The "interviewer" agent, powered by Claude. Works through a fixed,
// curated 24-question interview bank (QUESTION_BANK below) organized into
// 7 stages of a client project story - client/context, the problem, the
// before-state, complexity/discovery, the solution, technical decisions,
// and impact/results. Given the conversation so far, it decides what to ask
// next: the next bank question that genuinely hasn't been answered yet
// (skipping ones the expert already covered while answering something
// else), a sharp follow-up on something specific just mentioned, or any
// extra custom topics the caller supplied on top of the bank.
//
// Uses raw HTTPS against the Anthropic Messages API to match this project's
// zero-dependency serverless-proxy convention. Key is server-side only
// (ANTHROPIC_API_KEY). Model defaults to claude-opus-5.

// The fixed interview bank. Order is a sensible narrative default (context
// -> problem -> before -> complexity -> solution -> technical -> impact)
// but Claude is explicitly allowed to depart from this order when the
// expert's own answers make a different question more natural next.
const QUESTION_BANK = [
  { stage: "Client & context", question: "What does the client do, who uses their product/service, and what was happening in their business when this project started?" },
  { stage: "Client & context", question: "What exactly did the client bring us in to solve or build?" },
  { stage: "The problem", question: "What was the underlying problem behind the project? What wasn't working before we got involved?" },
  { stage: "The problem", question: "Who was affected by that problem, and how was it affecting their day-to-day work or business?" },
  { stage: "Before our solution", question: "Can you walk me through what the process/system looked like before our solution, step by step?" },
  { stage: "Before our solution", question: "What were the biggest pain points, bottlenecks, inefficiencies, or risks in that existing process?" },
  { stage: "Before our solution", question: "Why couldn't the client simply continue with the existing system or process? What made solving this important at that particular time?" },
  { stage: "Complexity & discovery", question: "What made this project more complicated or challenging than it initially appeared?" },
  { stage: "Complexity & discovery", question: "What did you discover during the project that wasn't obvious when we started?" },
  { stage: "Complexity & discovery", question: "What was the hardest problem you personally had to solve on this project, and why was it difficult?" },
  { stage: "Your role & the solution", question: "What was your specific role, and what parts of the solution did you personally work on?" },
  { stage: "Your role & the solution", question: "What did we ultimately build, change, or implement to solve the client's problem?" },
  { stage: "Your role & the solution", question: "Which parts of the solution directly addressed the client's biggest pain points?" },
  { stage: "Your role & the solution", question: "What were the most important features, capabilities, or workflows we introduced?" },
  { stage: "Technical decisions", question: "Were there any particularly difficult technical or functional requirements? How did you solve them?" },
  { stage: "Technical decisions", question: "What important technical, architectural, product, or design decisions did the team make, and why did you choose that approach?" },
  { stage: "Technical decisions", question: "Did you consider other approaches or technologies? If so, why did we reject them?" },
  { stage: "Technical decisions", question: "Were there any integrations, legacy systems, data issues, scalability requirements, security concerns, or other constraints that significantly influenced the solution?" },
  { stage: "Technical decisions", question: "Can you describe one specific problem or moment during development where the team had to think creatively or change direction?" },
  { stage: "Impact & results", question: "How did the solution change the way users or the client's team work compared with before?" },
  { stage: "Impact & results", question: "What changed after the solution was implemented? Give me a clear before-and-after comparison." },
  { stage: "Impact & results", question: "What measurable results or improvements did the client achieve? Please give specific numbers wherever possible." },
  { stage: "Impact & results", question: "If you don't have exact numbers, what observable changes can you confidently describe - for example, time saved, manual work eliminated, errors reduced, better performance, easier scaling, or improved user experience?" },
  { stage: "Impact & results", question: "What did the client specifically say or do after seeing the solution that showed them its value? Do you remember any exact words or feedback?" },
];

const SYSTEM_PROMPT = `You are an experienced documentation interviewer, live in a real spoken conversation with a subject-matter expert about a client project. A transcript will be built from this afterward. The expert dislikes writing but is comfortable talking, so your questions have to do the work: concrete, specific, one at a time, easy to answer out loud - and the conversation has to feel like a real person is listening, not a form being filled in.

You will be given:
- "questionBank": a fixed list of {stage, question} pairs - the core ground this interview needs to cover, roughly in narrative order.
- "extraTopics": optional additional topics the interviewer added on top of the bank (may be empty).
- "history": every question already asked and the expert's answer, in order. The expert may have spoken in English or another language, but every answer here has already been translated to English before it reaches you — always write your questions in English regardless.

STEP 1 - REMEMBER WHAT YOU'VE BEEN TOLD. Before deciding anything, mentally list every concrete fact, name, tool, number, decision, and event the expert has ALREADY told you, across ALL of history, not just the answer to the question it came up under. Experts constantly answer a later question while still talking about an earlier one (e.g. they mention what they built while explaining the original problem, or name the client while describing their role). Anything already stated anywhere in history counts as already known, no matter which question it came up under.

STEP 2 - decide the SINGLE next thing to ask, in this priority order:
1. FOLLOW-UP: if the most recent answer mentioned something specific but underexplored (a tool, a number, a decision, a person, a workaround, a surprising result) that ISN'T already covered elsewhere in history, ask ONE sharp follow-up digging into that specific detail.
2. NEXT BANK QUESTION: otherwise, go through questionBank (roughly in order, but skip around if it reads more naturally given what's already been said) and pick the next one that still has a real, unanswered gap based on your Step 1 review - not just one whose exact wording hasn't been asked yet. If the expert already substantively answered a bank question while answering something else, treat it as covered and move on instead of asking it "properly" from scratch. Once every bank question is reasonably covered, move to extraTopics the same way.

BE CONVERSATIONAL, NOT ROBOTIC - this is the most important thing to get right: when you move to a new question, don't just read it verbatim like a form. Briefly and naturally acknowledge something specific and real that the expert already told you (their client's name, what was built, the problem, whatever's relevant) before asking the new thing, the way an attentive interviewer naturally would. This is what makes the expert feel actually listened to instead of interrogated by a script. Keep it brief - one short clause, not a paragraph - then ask the question. Examples of the right feel (invent your own wording from the actual history, never reuse these verbatim):
- "Since you mentioned [client]'s team was drowning in manual spreadsheet work - what did that process actually look like day to day before you stepped in?"
- "Okay, so you built the mobile app in Flutter for [client] - walk me through the trickiest technical call you had to make building that."
- "Got it, that clears up the problem side. Switching gears - what was your specific role on this one?"
Do NOT do this on the very first question of the interview (there's nothing to reference yet), and do NOT force a callback where none is natural - if there's nothing specific to reference, just ask the next question cleanly.

When every bank question and every extra topic is reasonably covered by what's actually in history and there's nothing left worth a follow-up, respond with "done": true instead of a question.

Respond with ONLY valid JSON (no markdown fences, no preamble) in exactly this shape:
{
  "done": false,
  "topic": "the stage this question belongs to (verbatim from questionBank's \"stage\", or the extraTopics entry, or 'follow-up' if probing the last answer)",
  "question": "the single next question to ask, written as you would say it out loud - may open with a brief natural callback to something already said, then the question itself. One question only, no meta preamble like 'Great, next...'"
}

HARD RULES:
- NEVER ask for a fact, name, number, or description that is already present anywhere in history's answers, even in a different question's answer, even if worded slightly differently. This is the most common mistake - check twice.
- Ask ONE question at a time. Never stack multiple questions in one string.
- Keep the actual question concrete and answerable from memory: ask for specifics (what, who, when, how, why this and not that) rather than vague prompts like "tell me more".
- Keep the whole thing (callback + question) under ~45 words.
- If history is empty, ask a warm, concrete opening question based on the FIRST questionBank entry, with no callback (nothing to reference yet).

Output ONLY the JSON object.`;

async function callClaude(apiKey, model, extraTopics, history) {
  const userPayload = JSON.stringify({ questionBank: QUESTION_BANK, extraTopics, history }, null, 2);
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
          content: "Here is the question bank, any extra topics, and the interview history so far. Decide the next question:\n\n" + userPayload,
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

  let extraTopics, history;
  try {
    const body = JSON.parse(event.body || "{}");
    // "outline" is accepted as the field name for backward compatibility
    // with earlier callers/cached clients; it's treated as extra topics on
    // top of the fixed QUESTION_BANK, not a replacement for it.
    const rawExtra = Array.isArray(body.extraTopics) ? body.extraTopics : Array.isArray(body.outline) ? body.outline : [];
    extraTopics = rawExtra.map((t) => String(t).slice(0, 200)).slice(0, 20);
    history = Array.isArray(body.history)
      ? body.history.slice(-40).map((h) => ({
          question: String(h.question || "").slice(0, 500),
          // The browser sends this field as "answerText" (see public/interview.html);
          // accept "answer" too in case a caller uses the more natural name.
          answer: String(h.answerText || h.answer || "").slice(0, 4000),
        }))
      : [];
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5";

  try {
    const plan = parseJSON(await callClaude(apiKey, model, extraTopics, history));
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
