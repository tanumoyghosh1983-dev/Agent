// Netlify Function: design-casestudy.js
// The "design" agent, powered by Claude (Anthropic Messages API). The page
// template is now fully fixed — layout, typography, and the black/white/teal
// brand system all live in public/index.html and never change. What's left
// for a design agent to actually decide, within that fixed template, is art
// direction: which icon (from a fixed icon set) best represents each card,
// and what the supporting photography/imagery should depict.
//
// Uses raw HTTPS against the Anthropic Messages API to match this project's
// zero-dependency serverless-proxy convention. Key is server-side only
// (ANTHROPIC_API_KEY). Model defaults to claude-opus-5.

// The fixed icon set. The design agent may ONLY choose from these keys — the
// renderer owns the actual SVG for each. This is what keeps "one fixed
// template" true even though icon choice still requires real judgment.
const ICONS = [
  "mobile", "ai", "content", "sound", "check", "reward", "social", "battle",
  "network", "web", "cloud", "security", "time", "growth", "users", "settings",
  "idea", "target", "integration", "data", "payment", "support", "automation", "design",
];

const SYSTEM_PROMPT = `You are a senior art director working inside ONE fixed page template that never changes — fixed layout, fixed typography, fixed black/white/teal brand colors. You do NOT write HTML, CSS, or copy, and you cannot change the layout. Your job is only the two bounded creative decisions the template still needs: which icon best represents each card, and what the supporting imagery should depict.

You will be given the case study's content JSON (title, features array, results array, project/challenge text, etc). Respond with ONLY valid JSON (no markdown fences, no preamble) in exactly this shape:
{
  "icons": {
    "project": "one icon key",
    "challenge": "one icon key",
    "features": ["one icon key per item in content.features, same order, same length"],
    "results": ["one icon key per item in content.results, same order, same length"]
  },
  "images": {
    "hero": {"prompt": "a vivid, detailed art-direction prompt for a wide hero photo tied to this story's setting/industry"},
    "secondary": {"prompt": "a supporting image prompt, a different angle or moment from the same setting"},
    "solutionScreens": [
      {"prompt": "art-direction prompt for a phone-screen-shaped image depicting the product/app/interface described in the solution, screen 1"},
      {"prompt": "screen 2, a different screen or state of the same product"}
    ]
  }
}

ALLOWED ICON KEYS (choose only from this list, exactly as spelled):
${ICONS.join(", ")}

RULES:
- Every icon value MUST be exactly one of the allowed keys above. Pick the closest conceptual match for each card's title/description.
- "solutionScreens": provide 2 to 4 entries, matching how many distinct product screens or states the solution paragraph implies (default to 3 if unclear).
- Image prompts describe visuals ONLY — no text, words, letters, logos, charts, or UI text baked into the image (image models render text badly).
- CRITICAL: never depict a specific named real person's likeness. If the content names a real client, employee, or quote author, do NOT prompt for a photo of "them" — describe generic, unnamed people, settings, devices, or scenes appropriate to the story instead (e.g. "a bright classroom with students using tablets", not "a photo of [name]").
- "hero" and "secondary" should feel like real environmental/contextual photography suited to the industry, not generic stock-photo clichés.
- "solutionScreens" prompts should describe a mobile app or product screen's visual composition (colors, layout mood, imagery within it) — not literal text or labels, since those can't be rendered reliably.

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
      max_tokens: 4000,
      // Adaptive thinking is on by default on claude-opus-5 (we omit `thinking`);
      // low effort is plenty for bounded icon-picking + art direction and keeps
      // this comfortably inside a serverless function's time budget.
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            "Here is the fixed-format case study content. Produce the art direction JSON:\n\n" +
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

const FALLBACK_ICON = "check";
const okIcon = (k) => (ICONS.includes(k) ? k : FALLBACK_ICON);

// Clamps the plan to safe, in-system values: every icon must be from the
// fixed set, and icon arrays are padded/truncated to match the content
// arrays exactly so the renderer never runs out of icons mid-grid.
function normalize(plan, content) {
  const str = (v, n) => String(v == null ? "" : v).slice(0, n);

  const matchIcons = (arr, len) => {
    const list = Array.isArray(arr) ? arr.map(okIcon) : [];
    while (list.length < len) list.push(FALLBACK_ICON);
    return list.slice(0, len);
  };

  const solutionScreens = (Array.isArray(plan.images?.solutionScreens) ? plan.images.solutionScreens : [])
    .slice(0, 4)
    .map((s) => ({ prompt: str(s?.prompt, 700) }))
    .filter((s) => s.prompt);
  while (solutionScreens.length < 2 && plan.images?.solutionScreens) {
    solutionScreens.push({ prompt: str(plan.images.solutionScreens[0]?.prompt, 700) || "a modern mobile app interface" });
  }

  return {
    icons: {
      project: okIcon(plan.icons?.project),
      challenge: okIcon(plan.icons?.challenge),
      features: matchIcons(plan.icons?.features, (content.features || []).length),
      results: matchIcons(plan.icons?.results, (content.results || []).length),
    },
    images: {
      hero: { prompt: str(plan.images?.hero?.prompt, 700) },
      secondary: { prompt: str(plan.images?.secondary?.prompt, 700) },
      solutionScreens: solutionScreens.length ? solutionScreens : [{ prompt: "a clean modern mobile app interface, abstract UI composition" }],
    },
  };
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
    if (!plan) throw new Error("The art direction didn't come through cleanly. Please try again.");
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

module.exports.ICONS = ICONS;
