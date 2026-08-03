// Netlify Function: generate-casestudy.js
// The "writer + art director" stage of the agent. Takes raw, messy text
// (project notes, an email, a transcript, bullet points) and returns a fully
// structured case study as JSON: headline, narrative sections, grounded
// metrics, a design theme, and image prompts the illustration stage will use.
//
// Uses the OpenAI Chat Completions API. The API key lives ONLY in the
// server-side environment (OPENAI_API_KEY), never in the browser.

const SYSTEM_PROMPT = `You are a senior brand writer and art director at a design studio. You transform raw, unstructured input (notes, transcripts, emails, bullet points) into a polished, publication-ready CASE STUDY, and you also make the art direction decisions for how it should look.

Respond with ONLY valid JSON (no markdown fences, no preamble) in exactly this shape:
{
  "title": "punchy case study title, 3-8 words",
  "subtitle": "one-sentence summary of the story",
  "client": "the client / company / product name if present in the source, else a sensible generic like 'the client'",
  "industry": "short industry or domain label",
  "tags": ["3-5 short topic tags"],
  "theme": {
    "accent": "#RRGGBB — a primary accent color chosen to fit the story's mood and industry (NOT a random default)",
    "mood": "one word describing the visual mood, e.g. bold, calm, technical, warm, editorial",
    "font": "one of: sans, serif — pick what fits the mood"
  },
  "hero": {
    "imagePrompt": "a vivid, detailed prompt for a HERO image. Photographic or richly illustrative, conceptually tied to the story. IMPORTANT: describe imagery only — NO text, letters, words, logos, charts, or UI in the image."
  },
  "overview": "a 2-4 sentence lede paragraph that sets up the whole story",
  "metrics": [
    {"value": "e.g. 3x or 40% or 12 weeks", "label": "what it measures"}
  ],
  "sections": [
    {"heading": "The challenge", "body": "1-3 short paragraphs, separated by blank lines. You may use **bold** for emphasis and lines starting with '- ' for bullets.", "imagePrompt": "optional image prompt for this section, same rules as hero (imagery only, no text) — include only where an image genuinely helps"}
  ],
  "quote": {"text": "a pull quote", "author": "name", "role": "title/company"}
}

RULES — read carefully:
- GROUNDING: Only state facts, numbers, names, and quotes that are supported by the raw input. NEVER invent specific statistics, client names, or quotes that aren't in the source. If the input has no hard metrics, return "metrics": [] rather than making numbers up. If there's no real quote in the source, omit the "quote" field entirely (do not fabricate one).
- STRUCTURE: Use 3-5 sections. Good default arc: The challenge → The approach → The solution → The results/impact. Adapt headings to the actual content.
- Write in confident, concrete, editorial prose. No filler, no lorem ipsum, no marketing clichés like "in today's fast-paced world".
- Give 1-2 sections (usually the solution and results) an imagePrompt; not every section needs one.
- Image prompts must describe visuals ONLY — image models render text badly, so never ask for words, labels, logos, charts, or screens with text.
- Metrics: 0-4 items. Only include ones grounded in the source.

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
            "Turn the following raw input into a case study JSON per the schema:\n\n" +
            rawText,
        },
      ],
      temperature: 0.7,
      max_tokens: 2600,
      response_format: { type: "json_object" },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(
      data?.error?.message || "OpenAI request failed"
    );
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

// Guards against a malformed model response producing a broken page: fills in
// safe defaults and drops anything structurally wrong, so the rest of the
// pipeline always receives something renderable.
function normalize(cs) {
  const hexOk = (s) => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);
  const out = {
    title: String(cs.title || "Untitled Case Study").slice(0, 160),
    subtitle: String(cs.subtitle || "").slice(0, 300),
    client: String(cs.client || "the client").slice(0, 120),
    industry: String(cs.industry || "").slice(0, 80),
    tags: Array.isArray(cs.tags)
      ? cs.tags.slice(0, 6).map((t) => String(t).slice(0, 40))
      : [],
    theme: {
      accent: hexOk(cs.theme?.accent) ? cs.theme.accent : "#3B5BDB",
      mood: String(cs.theme?.mood || "editorial").slice(0, 30),
      font: cs.theme?.font === "serif" ? "serif" : "sans",
    },
    hero: {
      imagePrompt: String(cs.hero?.imagePrompt || "").slice(0, 800),
    },
    overview: String(cs.overview || "").slice(0, 1200),
    metrics: Array.isArray(cs.metrics)
      ? cs.metrics
          .filter((m) => m && (m.value || m.label))
          .slice(0, 4)
          .map((m) => ({
            value: String(m.value || "").slice(0, 20),
            label: String(m.label || "").slice(0, 60),
          }))
      : [],
    sections: Array.isArray(cs.sections)
      ? cs.sections
          .filter((s) => s && s.heading && s.body)
          .slice(0, 6)
          .map((s) => ({
            heading: String(s.heading).slice(0, 120),
            body: String(s.body).slice(0, 4000),
            imagePrompt: s.imagePrompt
              ? String(s.imagePrompt).slice(0, 800)
              : null,
          }))
      : [],
  };
  if (cs.quote && cs.quote.text) {
    out.quote = {
      text: String(cs.quote.text).slice(0, 500),
      author: String(cs.quote.author || "").slice(0, 80),
      role: String(cs.quote.role || "").slice(0, 120),
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

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error:
          "Server is missing OPENAI_API_KEY. Set it in Netlify site environment variables.",
      }),
    };
  }

  let rawText;
  try {
    const body = JSON.parse(event.body || "{}");
    rawText = (body.text || "").toString().trim();
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  if (!rawText) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Please provide some raw text to work from." }),
    };
  }
  if (rawText.length > 20000) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Input is too long (max 20,000 characters)." }),
    };
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o";

  try {
    const raw = await callOpenAI(apiKey, model, rawText);
    const parsed = parseJSON(raw);
    if (!parsed || !parsed.title || !Array.isArray(parsed.sections)) {
      throw new Error(
        "The case study didn't come through cleanly. Please try again."
      );
    }
    const caseStudy = normalize(parsed);
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(caseStudy),
    };
  } catch (err) {
    return {
      statusCode: err.statusCode || 502,
      headers,
      body: JSON.stringify({
        error: err.message || "Failed to generate the case study.",
      }),
    };
  }
};
