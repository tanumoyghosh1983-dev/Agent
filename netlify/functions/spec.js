// Netlify Function: spec.js
// Turns a generated prototype (the same JSON shape produce by generate.js)
// into a build-ready product specification: a real PRD the VE delivery team
// can quote from and start building against. This is what turns the demo
// prototype into a sales-to-delivery bridge instead of a throwaway mockup.
//
// Uses Gemini (GEMINI_API_KEY, server-side only). The prototype's screen
// list is deterministic input, so the model is grounding its spec in
// something concrete rather than inventing an app from a one-line prompt.

const SPEC_SYSTEM_PROMPT = `You are a senior product manager and solutions architect at a mobile app development studio. You are given a clickable prototype for a mobile app as JSON (its app name, screens, and the components on each screen), plus an optional one-line description of the original idea. Produce a build-ready product specification the engineering team can estimate and build from.

Respond with ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "appName": "string",
  "summary": "2-3 sentence plain-English description of what the app does and for whom",
  "targetUsers": ["short persona 1", "short persona 2"],
  "coreValue": "one sentence: the single most important job this app does for its user",
  "screens": [
    {
      "id": "must match a screen id from the prototype",
      "title": "screen title",
      "purpose": "one sentence: what the user accomplishes on this screen",
      "userStories": ["As a <role>, I want <goal> so that <benefit>", "..."],
      "keyElements": ["concrete UI/interaction elements this screen needs"],
      "effort": "one of: S, M, L, XL"
    }
  ],
  "dataModel": [
    {"entity": "EntityName", "fields": ["field: type", "field: type"], "notes": "relationships or constraints, short"}
  ],
  "apiSurface": [
    {"method": "GET|POST|PUT|DELETE", "path": "/resource", "purpose": "short"}
  ],
  "integrations": ["third-party services this realistically needs, e.g. Stripe, Twilio, maps, push notifications — empty array if none"],
  "risks": ["short engineering or scope risks worth flagging to the client"],
  "assumptions": ["things you assumed because the prototype didn't specify them"]
}

RULES:
- Every screen in your "screens" array MUST use an id that exists in the prototype. Cover every prototype screen; do not invent screens that aren't in the prototype.
- Write user stories that are specific to THIS app's domain, not generic filler. 1-3 per screen.
- Infer a realistic data model and API surface from what the screens actually show (lists imply a collection endpoint, detail screens imply a fetch-by-id, forms imply a create/update, carts imply order entities, etc.).
- Effort is a rough T-shirt size for building that screen end-to-end (UI + wiring + the backend it depends on): S = trivial/static, M = standard, L = complex flow or real backend, XL = heavy (payments, real-time, video, ML).
- Keep every string tight and concrete. No marketing language, no lorem ipsum.
- Only list integrations the screens actually imply. If it's a simple app, integrations can be an empty array.

Output ONLY the JSON object, nothing else.`;

// Single Gemini call against the native generateContent endpoint. Mirrors
// the approach proven in generate.js (same auth header, same JSON response
// mode) so both functions behave identically against the same key.
async function callGemini(apiKey, model, promptText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      generationConfig: {
        temperature: 0.4, // lower than prototype generation — specs should be steady, not creative
        maxOutputTokens: 8000,
        responseMimeType: "application/json",
      },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || "Gemini API request failed");
    err.statusCode = res.status;
    throw err;
  }
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n")
    .trim();
  if (!text) throw new Error("Gemini returned an empty response");
  return text;
}

function parseJSON(rawText) {
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

// Strips the prototype down to just what the spec model needs to reason
// about — screen ids, titles, types, and a compact view of each component.
// This keeps the prompt small and stops resolved image URLs (which can be
// long) from eating the token budget.
function condensePrototype(prototype) {
  return {
    appName: prototype.appName || "App",
    startScreen: prototype.startScreen,
    screens: (prototype.screens || []).map((s) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      components: (s.components || []).map((c) => {
        const out = { kind: c.kind };
        if (c.text) out.text = c.text;
        if (c.title) out.title = c.title;
        if (c.subtitle) out.subtitle = c.subtitle;
        if (c.label) out.label = c.label;
        if (c.navTo) out.navTo = c.navTo;
        if (c.items) out.items = c.items;
        return out;
      }),
    })),
  };
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error:
          "Server is missing GEMINI_API_KEY. Set it in Netlify site environment variables.",
      }),
    };
  }

  let prototype, idea;
  try {
    const body = JSON.parse(event.body || "{}");
    prototype = body.prototype;
    idea = (body.idea || "").toString().slice(0, 2000);
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  if (
    !prototype ||
    !Array.isArray(prototype.screens) ||
    prototype.screens.length === 0
  ) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing or invalid prototype data" }),
    };
  }

  const condensed = condensePrototype(prototype);
  const promptText =
    `${SPEC_SYSTEM_PROMPT}\n\n` +
    (idea ? `Original idea: ${idea}\n\n` : "") +
    `Prototype JSON:\n${JSON.stringify(condensed)}`;

  try {
    const raw = await callGemini(apiKey, "gemini-3.5-flash", promptText);
    const spec = parseJSON(raw);

    if (!spec || !Array.isArray(spec.screens)) {
      throw new Error(
        "The spec didn't come through cleanly this time. Please try generating it again."
      );
    }

    // Guardrail: keep only spec screens that map to a real prototype screen,
    // so a stray hallucinated screen id never leaks into the delivered spec.
    const validIds = new Set(prototype.screens.map((s) => s.id));
    spec.screens = spec.screens.filter((s) => s && validIds.has(s.id));

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    };
  } catch (err) {
    return {
      statusCode: err.statusCode || 502,
      headers,
      body: JSON.stringify({ error: err.message || "Failed to generate spec" }),
    };
  }
};
