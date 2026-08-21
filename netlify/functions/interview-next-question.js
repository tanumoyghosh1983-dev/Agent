// Netlify Function: interview-next-question.js
// The "interviewer" agent, powered by Claude. QUESTION_BANK is a baseline
// checklist (24 questions across 7 stages of a client project story) that
// guarantees minimum coverage — it is NOT a script the agent is confined
// to. Given the conversation so far, the agent picks whichever of three
// things is most valuable to ask next: a follow-up on something specific
// just mentioned, a genuinely new adaptive question about something
// interesting the bank doesn't cover at all, or the next uncovered bank
// question. See SYSTEM_PROMPT for the actual decision logic.
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

// The 7 questionBank stages, exported for the coverage-estimate schema and
// reused by the client-side depth meter.
const STAGES = [
  "Client & context", "The problem", "Before our solution", "Complexity & discovery",
  "Your role & the solution", "Technical decisions", "Impact & results",
];

const SYSTEM_PROMPT = `You are an experienced documentation interviewer, live in a real spoken conversation with a subject-matter expert about a client project. A transcript will be built from this afterward. The expert dislikes writing but is comfortable talking, so your questions have to do the work: concrete, specific, one at a time, easy to answer out loud - and the conversation has to feel like a real person is listening, not a form being filled in.

You will be given:
- "questionBank": a BASELINE CHECKLIST of {stage, question} pairs guaranteeing minimum coverage — NOT a script you're confined to. You are free, and encouraged, to go beyond it (see Step 2, mode C).
- "extraTopics": optional additional topics the interviewer added on top of the bank (may be empty).
- "projectMeta": optional {industry, technologies} the interviewer already knows about this project going in (may be empty/absent). Use it to make questions more specific and informed — e.g. if industry is "Fintech", a question about constraints can specifically ask about compliance/regulatory pressure rather than generic "any constraints?"; if technologies name specific tools, you can ask about them by name instead of "what tech did you use?". Never treat projectMeta as something the expert needs to be asked about again — it's already known.
- "referenceMaterial": optional background text (a project brief, ticket, notes) the interviewer already has about this project (may be empty/absent). Treat everything factual in it as already known — never ask for something already stated there. Use it to ask sharper, more informed questions and to target what it DOESN'T cover.
- "priorContext": optional summary of what a DIFFERENT expert already said in an earlier interview about this SAME project (may be empty/absent). Treat everything in it as already known — never re-ask for it. Since it's a different person's perspective, prefer questions that get at what THIS expert specifically knows or did that the earlier interview didn't cover (their own role, their own technical decisions, gaps the earlier person couldn't answer) rather than repeating the earlier interview's ground.
- "history": every question already asked and the expert's answer, in order. The expert may have spoken in English or another language, but every answer here has already been translated to English before it reaches you — always write your questions in English regardless.

STEP 1 - REMEMBER WHAT YOU'VE BEEN TOLD, WITH STRUCTURE. Before deciding anything, mentally build a running memory of facts from ALL of history, referenceMaterial, AND priorContext — not just the answer a fact came up under. Specifically track, by category: PEOPLE/ROLES named, the CLIENT/COMPANY name, DATES/TIMELINES mentioned, METRICS/NUMBERS claimed, PRODUCTS/FEATURES named, and TECHNOLOGIES/TOOLS named. Two things this memory is FOR:
  (a) never ask for something already in it, no matter which question or document it came from;
  (b) reference it naturally later — e.g. if "HomeTiger" was named as the client three questions ago, a later question can say "Was HomeTiger also involved in the rollout?" instead of a generic phrase. This is what makes the conversation feel like it's actually being listened to.

STEP 2 - decide the SINGLE next thing to ask. You have FOUR modes available, in this priority order — genuinely consider all of them each turn, don't default to the bank out of habit:

A) CONTRADICTION CHECK (highest priority — resolve immediately when found): compare the MOST RECENT answer against every fact tracked in Step 1's memory. If it conflicts with something stated earlier (a timeline, a number, a name, a claim that doesn't square with an earlier one), do not let it slide — ask about the discrepancy directly, naming both versions, e.g. "Earlier you mentioned the project took 6 months, but just now you said it launched in 3 - can you help me reconcile that?" This matters more than moving forward.

B) FOLLOW-UP / INCOMPLETE-ANSWER PROBE: if the most recent answer left something on the table, dig in — and be specific about what's missing rather than a vague "tell me more":
  - If it explained one part of a story but skipped the obvious next part (e.g. described the challenge but never said how it was solved, or named a decision but not why), name the specific gap: "You explained the challenge well, but I don't yet understand how you actually solved it - can you walk me through that part?"
  - If it gave a QUANTITATIVE or metric claim (a percentage, a number, "faster", "reduced", "improved"), do not just accept it — drill in on at least one of: how it was measured, what the baseline/before-state was, and whether it covers all users or just some. Quantitative claims deserve rigor; that's often where the real substance of a case study lives.
  - If it mentioned a tool, person, workaround, or surprising result that's genuinely underexplored and isn't covered elsewhere, ask ONE sharp follow-up on that specific detail.

C) ADAPTIVE QUESTION (use this often — it's how the best details get captured): if something the expert said opens up a thread that's clearly valuable for a case study but ISN'T represented anywhere in questionBank or extraTopics at all — a competitor mentioned, an unusual team dynamic, a client relationship detail, a surprising pivot, a budget/timeline pressure, a story behind a specific decision — ask a genuinely new question about it, invented fresh for this moment, not a rephrasing of a bank question. The bank guarantees a floor of coverage; it was never meant to be a ceiling on what's worth asking. Trust your judgment about what a good case study actually needs.

D) NEXT BANK QUESTION: otherwise, go through questionBank (roughly in order, but skip around if it reads more naturally given what's already been said) and pick the next one that still has a real, unanswered gap based on your Step 1 review - not just one whose exact wording hasn't been asked yet. If the expert already substantively answered a bank question while answering something else, treat it as covered and move on instead of asking it "properly" from scratch. Once every bank question is reasonably covered, move to extraTopics the same way.

BE CONVERSATIONAL, NOT ROBOTIC - this is the most important thing to get right: when you move to a new question, don't just read it verbatim like a form. Briefly and naturally acknowledge something specific and real that the expert already told you (their client's name, what was built, the problem, whatever's relevant) before asking the new thing, the way an attentive interviewer naturally would. Keep it brief - one short clause, not a paragraph - then ask the question. Examples of the right feel (invent your own wording from the actual history, never reuse these verbatim):
- "Since you mentioned HomeTiger's team was drowning in manual spreadsheet work - what did that process actually look like day to day before you stepped in?"
- "Okay, so you built the mobile app in Flutter for HomeTiger - walk me through the trickiest technical call you had to make building that."
- "Wait, you mentioned a competitor almost won this contract - what tipped it in our favor?" (mode C, an adaptive question the bank never asked for)
- "Earlier you said this took 6 months, but that last answer implied 3 - can you clarify which it was?" (mode A, a contradiction)
- "Got it, that clears up the problem side. Switching gears - what was your specific role on this one?"
Do NOT do this on the very first question of the interview (there's nothing to reference yet), and do NOT force a callback where none is natural - if there's nothing specific to reference, just ask the next question cleanly.

A LITTLE EMPATHY GOES A LONG WAY: if the expert's last answer described something genuinely stressful, frustrating, high-pressure, or hard-won (a crunch, a near-miss, a difficult client moment, a mistake they had to fix), it's fine to acknowledge that briefly and human before moving on - "That sounds like a stressful few weeks" or "Rough spot to be in" - a few words, not a paragraph, and never on routine factual answers where it would feel forced or patronizing. This is a light touch, not a therapy session: most turns need no emotional acknowledgment at all, just the ordinary factual callback described above.

When every bank question and every extra topic is reasonably covered by what's actually in history, and there's no follow-up, contradiction, or adaptive thread left worth pursuing, respond with "done": true instead of a question.

ALSO, on every turn (whether or not history is empty), provide two more things:

"answerFeedback": brief quality flags for the MOST RECENT answer in history (omit this field entirely if history is empty — there's no answer yet to assess). Choose zero or more from this fixed vocabulary: "too_short" (gave far less than the question warranted), "too_vague" (no concrete specifics — no names, numbers, or examples), "too_technical" (deep jargon a case-study reader won't follow, without ever explaining it in plain terms), "missing_example" (made a general claim with no concrete instance), "missing_numbers" (described an improvement/result without any quantification). Only include a flag if it clearly and fairly applies — an empty array means the answer was solid. Be a fair coach, not a harsh critic: most real answers deserve zero or one flag, not several.

"coverage": your own honest estimate of how substantively covered each of these 7 stages is by everything in history so far, as a 0-100 integer per stage (0 if nothing about that stage has been said, 100 if it's thoroughly covered) — judge by actual substance, not by how many bank questions from that stage were literally asked:
{"Client & context": 0, "The problem": 0, "Before our solution": 0, "Complexity & discovery": 0, "Your role & the solution": 0, "Technical decisions": 0, "Impact & results": 0}

Respond with ONLY valid JSON (no markdown fences, no preamble) in exactly this shape:
{
  "done": false,
  "topic": "a short label for what this question is about — the questionBank stage if it's mode D, the extraTopics entry, 'follow-up' for mode B, 'contradiction' for mode A, or a short invented label like 'competitive context' for mode C",
  "question": "the single next question to ask, written as you would say it out loud - may open with a brief natural callback to something already said, then the question itself. One question only, no meta preamble like 'Great, next...'",
  "answerFeedback": ["missing_numbers"],
  "coverage": {"Client & context": 80, "The problem": 60, "Before our solution": 40, "Complexity & discovery": 20, "Your role & the solution": 10, "Technical decisions": 0, "Impact & results": 0}
}

HARD RULES:
- NEVER ask for a fact, name, number, or description that is already present anywhere in history, referenceMaterial, or priorContext, even worded slightly differently. This is the most common mistake - check twice.
- Ask ONE question at a time. Never stack multiple questions in one string.
- Keep the actual question concrete and answerable from memory: ask for specifics (what, who, when, how, why this and not that) rather than vague prompts like "tell me more".
- Keep the whole thing (callback + question) under ~45 words.
- If history is empty, ask a warm, concrete opening question based on the FIRST questionBank entry, with no callback (nothing to reference yet), omit "answerFeedback", and set every coverage value to 0.

Output ONLY the JSON object.`;

async function callClaude(apiKey, model, extraTopics, history, projectMeta, priorContext, referenceMaterial) {
  const userPayload = JSON.stringify(
    { questionBank: QUESTION_BANK, extraTopics, projectMeta, referenceMaterial, priorContext, history },
    null,
    2
  );
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      // "low" effort was too shallow to reliably cross-check the whole
      // conversation for facts already mentioned under a different topic,
      // which caused repeat/redundant questions. "medium" costs a bit more
      // latency per question but actually reasons about what's known —
      // now also doing contradiction-checking and coverage estimation in
      // the same pass, which needs the extra reasoning budget even more.
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

  let extraTopics, history, projectMeta, priorContext, referenceMaterial;
  try {
    const body = JSON.parse(event.body || "{}");
    // "outline" is accepted as the field name for backward compatibility
    // with earlier callers/cached clients; it's treated as extra topics on
    // top of the fixed QUESTION_BANK, not a replacement for it.
    const rawExtra = Array.isArray(body.extraTopics) ? body.extraTopics : Array.isArray(body.outline) ? body.outline : [];
    extraTopics = rawExtra.map((t) => String(t).slice(0, 200)).slice(0, 20);
    history = Array.isArray(body.history)
      // 40 turns was cutting off early facts on longer interviews and on
      // interviews continued after "add more information" — a 24-question
      // baseline plus follow-ups, adaptive questions, and a continuation
      // round easily clears that. 90 turns comfortably covers realistic
      // sessions while staying well inside the model's context budget even
      // at effort "medium".
      ? body.history.slice(-90).map((h) => ({
          question: String(h.question || "").slice(0, 500),
          // The browser sends this field as "answerText" (see public/interview.html);
          // accept "answer" too in case a caller uses the more natural name.
          answer: String(h.answerText || h.answer || "").slice(0, 4000),
        }))
      : [];
    projectMeta = body.projectMeta && typeof body.projectMeta === "object"
      ? { industry: String(body.projectMeta.industry || "").slice(0, 100), technologies: String(body.projectMeta.technologies || "").slice(0, 300) }
      : null;
    priorContext = body.priorContext ? String(body.priorContext).slice(0, 8000) : null;
    referenceMaterial = body.referenceMaterial ? String(body.referenceMaterial).slice(0, 12000) : null;
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5";
  const VALID_FEEDBACK = new Set(["too_short", "too_vague", "too_technical", "missing_example", "missing_numbers"]);

  try {
    const plan = parseJSON(await callClaude(apiKey, model, extraTopics, history, projectMeta, priorContext, referenceMaterial));
    if (!plan) throw new Error("The interviewer response didn't come through cleanly. Please try again.");

    const coverage = {};
    STAGES.forEach((stage) => {
      const v = plan.coverage && typeof plan.coverage === "object" ? Number(plan.coverage[stage]) : 0;
      coverage[stage] = Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0;
    });
    const answerFeedback = Array.isArray(plan.answerFeedback)
      ? plan.answerFeedback.filter((f) => VALID_FEEDBACK.has(f)).slice(0, 5)
      : [];

    const out = plan.done
      ? { done: true, coverage }
      : {
          done: false,
          topic: String(plan.topic || "").slice(0, 200),
          question: String(plan.question || "").slice(0, 500),
          answerFeedback,
          coverage,
        };
    if (!out.done && !out.question) throw new Error("No question was generated. Please try again.");
    return { statusCode: 200, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(out) };
  } catch (err) {
    return { statusCode: err.statusCode || 502, headers, body: JSON.stringify({ error: err.message || "Failed to generate the next question." }) };
  }
};
