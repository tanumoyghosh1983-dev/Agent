// Netlify Function: generate-content.js
// The "writer" agent. Turns raw, unstructured text into case study content in
// ONE fixed format — the same fields and the same four canonical sections
// every time. It makes NO design decisions (no colors, no layout, no image
// direction); that is the design agent's job. Keeping content and design in
// separate agents is what lets every case study come out in a consistent
// structure and a consistent look.
//
// Uses the OpenAI Chat Completions API. Key is server-side only (OPENAI_API_KEY).

const SYSTEM_PROMPT = `You are a senior brand writer. You transform raw, unstructured input (notes, transcripts, emails, bullet points) into a CASE STUDY written in a FIXED format. Every case study you produce has exactly the same structure — do not add, remove, rename, or reorder fields.

Respond with ONLY valid JSON (no markdown fences, no preamble) in exactly this shape:
{
  "title": "punchy case study title, 3-8 words",
  "subtitle": "one-sentence summary of the story",
  "client": "the client / company / product name if present in the source, else a sensible generic like 'the client'",
  "industry": "short industry or domain label",
  "tags": ["3-5 short topic tags"],
  "summary": "a 2-4 sentence lede paragraph that sets up the whole story",
  "challenge": "1-3 short paragraphs on the problem the client faced. Separate paragraphs with a blank line.",
  "approach": "1-3 short paragraphs on how the problem was approached.",
  "solution": "1-3 short paragraphs on what was actually built or delivered.",
  "results": "1-3 short paragraphs on the outcome and impact.",
  "metrics": [ {"value": "e.g. 3x or 40% or 12 weeks", "label": "what it measures"} ],
  "quote": {"text": "a pull quote", "author": "name", "role": "title/company"}
}

RULES — read carefully:
- The four sections "challenge", "approach", "solution", and "results" are MANDATORY and always present, in that order. If the source is thin on one, write the most honest short version you can from what's given — never leave it empty and never merge sections.
- GROUNDING: Only state facts, numbers, names, and quotes supported by the raw input. NEVER invent specific statistics, client names, or quotes. If the input has no hard metrics, return "metrics": []. If there is no real quote in the source, omit the "quote" field entirely — do not fabricate one.
- Write in confident, concrete, editorial prose. No filler, no lorem ipsum, no clichés like "in today's fast-paced world".
- You may use **bold** for emphasis and lines starting with "- " for bullets inside the section bodies.
- Metrics: 0-4 items, only ones grounded in the source.

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
      max_tokens: 2400,
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

// Enforces the fixed shape so the design agent and renderer always receive the
// same fields, even if the model drifts.
function normalize(c) {
  const str = (v, n) => String(v == null ? "" : v).slice(0, n);
  const out = {
    title: str(c.title || "Untitled Case Study", 160),
    subtitle: str(c.subtitle, 300),
    client: str(c.client || "the client", 120),
    industry: str(c.industry, 80),
    tags: Array.isArray(c.tags) ? c.tags.slice(0, 5).map((t) => str(t, 40)) : [],
    summary: str(c.summary, 1200),
    challenge: str(c.challenge, 4000),
    approach: str(c.approach, 4000),
    solution: str(c.solution, 4000),
    results: str(c.results, 4000),
    metrics: Array.isArray(c.metrics)
      ? c.metrics
          .filter((m) => m && (m.value || m.label))
          .slice(0, 4)
          .map((m) => ({ value: str(m.value, 20), label: str(m.label, 60) }))
      : [],
  };
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
