// Netlify Function: design-casestudy.js
// The "design" agent, powered by Claude (Anthropic Messages API). It receives
// the fixed-format content from the writer agent and produces a DESIGN PLAN:
// the bounded set of decisions that a designer makes when placing content into
// ONE fixed template — the accent color (from an approved palette), the
// display headline, which single metric to feature, the art direction for the
// two fixed image slots, and which quote to pull.
//
// The template itself is fixed and lives in the renderer; the design agent
// does not emit HTML or CSS. That is what guarantees every case study comes
// out in the same design format while still getting real, content-aware
// design judgment.
//
// Uses raw HTTPS against the Anthropic Messages API to match this project's
// zero-dependency serverless-proxy convention. Key is server-side only
// (ANTHROPIC_API_KEY). Model defaults to claude-opus-5.

// The approved accent palette. The design agent may ONLY choose one of these
// keys — the renderer maps the key to a hex value. Fixing the palette is part
// of "one design format": the accent adapts to the story, the system does not.
const PALETTE = ["indigo", "teal", "crimson", "amber", "forest", "slate", "plum", "rust"];

const SYSTEM_PROMPT = `You are a senior art director. A case study will always be rendered into ONE fixed template with a fixed layout and fixed typography: a hero (eyebrow, big headline, subtitle, and one hero image), a client/industry/tags meta bar, an overview lede, a metrics band, four fixed sections in order (The challenge, Our approach, The solution, The results) with one image inside the solution section, a pull-quote band, and a footer.

You do NOT write HTML, CSS, or layout — the template is fixed. Your job is only the bounded design decisions that adapt this specific story to that template. Respond with ONLY valid JSON (no markdown fences, no preamble) in exactly this shape:
{
  "accent": "one of: indigo, teal, crimson, amber, forest, slate, plum, rust — choose the one that best fits the story's industry and mood",
  "eyebrow": "a short kicker for above the headline, e.g. 'Logistics · Case Study' (<= 6 words)",
  "displayTitle": "the headline to show, refined to fit a hero (<= 8 words)",
  "displaySubtitle": "one supporting line under the headline",
  "heroMetric": {"value": "the single most striking metric", "label": "what it measures"},
  "metrics": [ {"value": "...", "label": "..."} ],
  "heroImage": {
    "prompt": "a vivid, detailed art-direction prompt for the HERO image — photographic or richly conceptual, tied to the story. Describe imagery ONLY: no text, letters, words, logos, charts, or UI (image models render those badly).",
    "caption": "a short caption for the hero image"
  },
  "midImage": {
    "prompt": "art-direction prompt for the image inside the solution section — same rules as the hero image (imagery only, no text).",
    "caption": "a short caption for this image"
  },
  "pullQuote": {"text": "...", "author": "...", "role": "..."}
}

RULES:
- "accent" MUST be exactly one of the eight allowed keys. Do not invent a color or a hex value.
- Choose "heroMetric" and up to 3 "metrics" ONLY from the metrics present in the content. If the content has no metrics, set "heroMetric": null and "metrics": []. Never invent numbers.
- "displayTitle" and "displaySubtitle" should be tightened versions of the content's title/subtitle that read well large — do not introduce new claims.
- Set "pullQuote" from the content's quote if one exists; if the content has no quote, set "pullQuote": null. Never fabricate a quote or an attribution.
- Image prompts describe visuals ONLY. Never request text, words, labels, logos, charts, or screens with text in an image.
- Keep every string tight. No marketing clichés.

Output ONLY the JSON object.`;

async function callClaude(apiKey, model, contentJSON) {
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
      // Low effort keeps this fast enough for a serverless function while still
      // giving Claude room to reason. Adaptive thinking is on by default on
      // claude-opus-5 (we omit the `thinking` field), which suits design
      // judgment; max_tokens covers thinking + the small JSON output.
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            "Here is the fixed-format case study content. Produce the design plan JSON:\n\n" +
            contentJSON,
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
  // Safety classifiers can decline with HTTP 200 + stop_reason "refusal" —
  // check before reading content.
  if (data.stop_reason === "refusal") {
    throw new Error("The design step was declined for this input. Try different source text.");
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

// Constrains the design plan to safe, in-template values so the renderer never
// receives an out-of-palette color or a hallucinated metric/quote.
function normalize(plan, content) {
  const str = (v, n) => String(v == null ? "" : v).slice(0, n);
  const contentMetricLabels = new Set((content.metrics || []).map((m) => m.label));
  const pickMetric = (m) =>
    m && m.value && m.label ? { value: str(m.value, 20), label: str(m.label, 60) } : null;

  const out = {
    accent: PALETTE.includes(plan.accent) ? plan.accent : "indigo",
    eyebrow: str(plan.eyebrow || (content.industry ? content.industry + " · Case Study" : "Case Study"), 60),
    displayTitle: str(plan.displayTitle || content.title, 160),
    displaySubtitle: str(plan.displaySubtitle || content.subtitle, 300),
    heroMetric: null,
    metrics: [],
    heroImage: {
      prompt: str(plan.heroImage?.prompt, 800),
      caption: str(plan.heroImage?.caption, 160),
    },
    midImage: {
      prompt: str(plan.midImage?.prompt, 800),
      caption: str(plan.midImage?.caption, 160),
    },
    pullQuote: null,
  };

  // Metrics may only reference metrics that actually exist in the content.
  if ((content.metrics || []).length) {
    const hero = pickMetric(plan.heroMetric);
    if (hero && contentMetricLabels.has(hero.label)) out.heroMetric = hero;
    out.metrics = (Array.isArray(plan.metrics) ? plan.metrics : [])
      .map(pickMetric)
      .filter((m) => m && contentMetricLabels.has(m.label))
      .slice(0, 3);
    // Fall back to the content's own metrics if the plan dropped them.
    if (!out.heroMetric && content.metrics[0]) out.heroMetric = content.metrics[0];
    if (out.metrics.length === 0) out.metrics = content.metrics.slice(0, 3);
  }

  // A pull quote may only come from the content's real quote.
  if (content.quote && content.quote.text) {
    out.pullQuote = {
      text: str(content.quote.text, 500),
      author: str(content.quote.author, 80),
      role: str(content.quote.role, 120),
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Server is missing ANTHROPIC_API_KEY. Set it in Netlify site environment variables.",
      }),
    };
  }

  let content;
  try {
    content = JSON.parse(event.body || "{}").content;
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }
  if (!content || !content.title) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing case study content" }) };
  }

  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5";

  try {
    const plan = parseJSON(await callClaude(apiKey, model, JSON.stringify(content)));
    if (!plan) throw new Error("The design plan didn't come through cleanly. Please try again.");
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(normalize(plan, content)),
    };
  } catch (err) {
    return {
      statusCode: err.statusCode || 502,
      headers,
      body: JSON.stringify({ error: err.message || "Failed to design the case study." }),
    };
  }
};

module.exports.PALETTE = PALETTE;
