// Netlify Function: generate-content.js
// The "writer" agent. Turns raw, unstructured text into case study content in
// ONE fixed format, matching every content slot of the single fixed template
// (see public/index.html buildHTML()): hero headline + meta line, quick
// snapshot, story section, project/challenge cards, solution blurb, feature
// grid, results grid, tools table, testimonial, and CTA.
//
// This agent makes NO visual decisions (no colors, no icons, no image
// direction) — that is the design agent's job (design-casestudy.js). Keeping
// content and design in separate agents, and the template itself fixed, is
// what makes every case study come out in the same structure and the same
// look.
//
// Uses the OpenAI Chat Completions API. Key is server-side only (OPENAI_API_KEY).

const SYSTEM_PROMPT = `You are a senior case study writer at a software development agency. You transform raw, unstructured input (notes, transcripts, emails, bullet points) into case study copy for a FIXED page template. Every case study you write fills exactly the same slots — do not add, remove, rename, or reorder fields.

Respond with ONLY valid JSON (no markdown fences, no preamble) in exactly this shape:
{
  "title": "the hero headline, 6-14 words, written so it reads well across two centered lines",
  "highlightPhrase": "an exact substring copied verbatim from \\"title\\" (case-sensitive) to visually emphasize — usually the outcome or the technology angle. Empty string if nothing stands out.",
  "client": "the client / company name if present in the source, else a sensible generic like 'the client'",
  "industry": "short industry label, e.g. 'Education', 'Logistics', 'Healthcare'",
  "service": "short label for the type of engagement, e.g. 'Mobile App Development', 'Web Platform Build'",
  "technology": "short comma-separated list of specific technologies ONLY if the source names them, e.g. 'Flutter, Node.js, OpenAI'. Empty string if the source doesn't name specific technologies — never guess a stack.",
  "snapshot": "a 2-3 sentence 'quick snapshot' summary of the core problem and story, written to stand alone",
  "storyHeading": "a short, punchy heading for the narrative section, 4-9 words",
  "clientPara": "1 short paragraph introducing the client and their situation",
  "secondaryCaption": "a short (3-6 word) caption for a supporting image, e.g. a key insight or moment from the story",
  "project": "1 short paragraph describing what the project was, for a 'The Project' card",
  "challenge": "1 short paragraph describing the core challenge, for a 'The Challenge' card",
  "solutionHeading": "a short heading for the solution section, 4-9 words",
  "solutionPara": "1-2 short paragraphs on what was actually built",
  "featuresHeading": "a short heading for a feature highlights grid, 4-10 words",
  "features": [ {"title": "short feature name", "description": "1 sentence"} ],
  "resultEyebrow": "a short label above the results heading, e.g. 'The Result'",
  "resultHeading": "a short heading summarizing the outcome, 4-10 words",
  "results": [ {"title": "short result name", "description": "1 sentence"} ],
  "toolsHeading": "a short heading for a tech-stack table, only meaningful if technologies were named",
  "tools": [ {"layer": "e.g. 'Mobile App'", "technology": "e.g. 'Flutter'", "whatItPowered": "short phrase"} ],
  "quote": {"text": "a pull quote", "author": "name", "role": "title/company"},
  "ctaHeading": "a short closing line, e.g. 'This Could Be Your Success Story'",
  "ctaButtonLabel": "a short button label, e.g. 'Get in Touch'"
}

RULES — read carefully:
- GROUNDING IS CRITICAL. Only state facts, numbers, names, technologies, and quotes that are directly supported by the raw input.
  - "technology" and "tools": if the source does not name specific real technologies, return "technology": "" and "tools": []. NEVER guess or invent a tech stack.
  - "quote": if there is no real quote in the source, OMIT the "quote" field entirely. Never fabricate one.
  - "features" and "results": these should restate or reasonably summarize things actually described in the source (what was built, what it did, what changed). Never invent a capability, statistic, or outcome that isn't implied by the source.
- "features": 2 to 4 items. "results": 3 to 6 items. "tools": 0 to 8 rows.
- "highlightPhrase" MUST be an exact, verbatim substring of "title" (same characters, same case) so it can be found and highlighted — or an empty string.
- Write in confident, concrete, editorial prose. No filler, no lorem ipsum, no clichés like "in today's fast-paced world".
- Keep every string tight — this is copy for a real page layout, not an essay.

Output ONLY the JSON object.`;

async function callOpenAI(apiKey, model, rawText) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            "Turn the following raw input into fixed-format case study content:\n\n" +
            rawText,
        },
      ],
      temperature: 0.6,
      max_tokens: 3200,
      response_format: { type: "json_object" },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || "OpenAI request failed");
    err.statusCode = res.status;
    throw err;
  }
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("OpenAI returned an empty response");
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

// Enforces the fixed shape so the design agent and renderer always receive
// the same fields, in the same bounds, even if the model drifts.
function normalize(c) {
  const str = (v, n) => String(v == null ? "" : v).slice(0, n);
  const items = (arr, n, fields) =>
    Array.isArray(arr)
      ? arr
          .filter((x) => x && typeof x === "object")
          .slice(0, n)
          .map((x) => {
            const o = {};
            for (const f of fields) o[f.k] = str(x[f.k], f.n);
            return o;
          })
          .filter((o) => fields.some((f) => o[f.k]))
      : [];

  const title = str(c.title || "Untitled Case Study", 180);
  let highlightPhrase = str(c.highlightPhrase, 80);
  if (!highlightPhrase || !title.includes(highlightPhrase)) highlightPhrase = "";

  const out = {
    title,
    highlightPhrase,
    client: str(c.client || "the client", 120),
    industry: str(c.industry, 60),
    service: str(c.service, 80),
    technology: str(c.technology, 200),
    snapshot: str(c.snapshot, 700),
    storyHeading: str(c.storyHeading || "The Story Behind The Work", 140),
    clientPara: str(c.clientPara, 900),
    secondaryCaption: str(c.secondaryCaption, 60),
    project: str(c.project, 900),
    challenge: str(c.challenge, 900),
    solutionHeading: str(c.solutionHeading || "Designing The Solution", 140),
    solutionPara: str(c.solutionPara, 1400),
    featuresHeading: str(c.featuresHeading || "Key Features", 140),
    features: items(c.features, 4, [
      { k: "title", n: 60 },
      { k: "description", n: 200 },
    ]),
    resultEyebrow: str(c.resultEyebrow || "The Result", 40),
    resultHeading: str(c.resultHeading || "The Outcome", 140),
    results: items(c.results, 6, [
      { k: "title", n: 60 },
      { k: "description", n: 200 },
    ]),
    toolsHeading: str(c.toolsHeading || `The Tools Behind ${str(c.client || "the Build", 60)}`, 140),
    tools: items(c.tools, 8, [
      { k: "layer", n: 60 },
      { k: "technology", n: 80 },
      { k: "whatItPowered", n: 120 },
    ]),
    ctaHeading: str(c.ctaHeading || "This Could Be Your Success Story", 140),
    ctaButtonLabel: str(c.ctaButtonLabel || "Get In Touch", 40),
  };

  // Only keep tools rows that have at least a layer + technology — a row
  // missing the technology name is worse than no row.
  out.tools = out.tools.filter((t) => t.layer && t.technology);

  if (c.quote && c.quote.text) {
    out.quote = {
      text: str(c.quote.text, 500),
      author: str(c.quote.author, 80),
      role: str(c.quote.role, 120),
    };
  }
  return out;
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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Server is missing OPENAI_API_KEY. Set it in Netlify site environment variables.",
      }),
    };
  }

  let rawText;
  try {
    rawText = (JSON.parse(event.body || "{}").text || "").toString().trim();
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }
  if (!rawText)
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Please provide some raw text to work from." }) };
  if (rawText.length > 20000)
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Input is too long (max 20,000 characters)." }) };

  const model = process.env.OPENAI_MODEL || "gpt-4o";

  try {
    const parsed = parseJSON(await callOpenAI(apiKey, model, rawText));
    if (!parsed || !parsed.title) {
      throw new Error("The content didn't come through cleanly. Please try again.");
    }
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(normalize(parsed)),
    };
  } catch (err) {
    return {
      statusCode: err.statusCode || 502,
      headers,
      body: JSON.stringify({ error: err.message || "Failed to generate content." }),
    };
  }
};
