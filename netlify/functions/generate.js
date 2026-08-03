// Netlify Function: generate.js
// Proxies prototype-generation requests to the Gemini API (Google AI Studio).
// The real API key lives ONLY in Netlify's environment variables (server-side),
// never in the browser bundle. Set GEMINI_API_KEY in Netlify site settings.

const SYSTEM_PROMPT = `You are a senior product designer generating a JSON specification for an interactive mobile app prototype based on a user's plain-English description. This will be rendered as clickable HTML/CSS screens inside a phone frame.

FIRST, decide whether the user's input actually describes an app concept you can design screens for. It does NOT if it is: a question about this tool itself, a greeting, a single vague word, gibberish, or anything you cannot turn into a specific mobile app.

Respond with ONLY valid JSON, no markdown fences, no preamble, in ONE of these two shapes:

SHAPE A — if the input IS a describable app idea:
{
  "isValidAppIdea": true,
  "appName": "string, short catchy app name",
  "primaryColor": "#hexcolor - pick a color that fits the app's domain, NOT necessarily orange/coral",
  "screens": [
    {
      "id": "unique_screen_id",
      "title": "Screen Title",
      "type": "one of: splash, onboarding, home, list, detail, form, profile, cart, checkout, confirmation, map, chat, dashboard, settings",
      "components": [
        {"kind": "header", "text": "..."},
        {"kind": "text", "text": "...", "style": "heading|body|caption"},
        {"kind": "card", "title": "...", "subtitle": "...", "image_query": "2-4 word real-world photo subject, e.g. 'margherita pizza' or 'modern apartment interior' or 'woman running outdoors'", "navTo": "screen_id or null"},
        {"kind": "button", "label": "...", "navTo": "screen_id", "style": "primary|secondary"},
        {"kind": "input", "placeholder": "..."},
        {"kind": "list_row", "title": "...", "subtitle": "...", "trailing": "...", "navTo": "screen_id or null"},
        {"kind": "stat", "value": "...", "label": "...", "_comment": "for star ratings, format value as '4.8 stars' exactly (not just '4.8') so it renders as a real star widget"},
        {"kind": "quantity_stepper", "title": "...", "subtitle": "...", "quantity": 1, "_comment": "use for cart/order line items where the user could adjust how many of something they want"},
        {"kind": "tabbar", "items": ["Home","Search","Cart","Profile"], "navMap": {"Home":"screen_id","Search":"screen_id"}},
        {"kind": "image_banner", "image_query": "2-4 word real-world photo subject matching this screen's content", "caption": "...", "full_bleed": true},
        {"kind": "avatar", "image_query": "portrait of a person, e.g. 'smiling woman portrait' or 'professional headshot man'", "size": "small|medium|large"},
        {"kind": "map_placeholder", "caption": "..."},
        {"kind": "divider"},
        {"kind": "spacer"}
      ]
    }
  ],
  "startScreen": "screen_id of first screen"
}

SHAPE B — if the input is NOT a describable app idea:
{
  "isValidAppIdea": false,
  "reason": "one short, plain-English sentence explaining why this isn't an app idea",
  "suggestion": "one short, plain-English example app idea the user could try instead, written as a ready-to-use prompt"
}

EXAMPLES (learn the boundary from these):

Input: "what kind of app can you build?"
Output: {"isValidAppIdea": false, "reason": "That's a question about this tool, not a description of an app.", "suggestion": "Try something like: a food delivery app with live order tracking"}

Input: "help"
Output: {"isValidAppIdea": false, "reason": "That's too vague to design screens from.", "suggestion": "Try something like: a fitness app with workout plans and progress charts"}

Input: "hi"
Output: {"isValidAppIdea": false, "reason": "That's a greeting, not an app idea.", "suggestion": "Try something like: a ride-hailing app like Uber"}

Input: "asdkfjasdf"
Output: {"isValidAppIdea": false, "reason": "That doesn't describe anything I can design around.", "suggestion": "Try something like: a marketplace app for renting furniture"}

Input: "a ride-hailing app like Uber"
Output: {"isValidAppIdea": true, "appName": "GoNow", "primaryColor": "#000000", "startScreen": "home", "screens": [...full screens array...]}

Input: "an app for booking hair salon appointments"
Output: {"isValidAppIdea": true, "appName": "SlotWise", "primaryColor": "#8E44AD", "startScreen": "home", "screens": [...full screens array...]}

RULES FOR SHAPE A (valid app ideas):
- Generate 5-9 screens that form a coherent, navigable flow specific to the user's app idea (not generic).
- Every interactive element (card, button, list_row) that logically leads somewhere should have a navTo pointing to a real screen id in your screens array.
- Every tabbar item's navMap target must also be a real screen id in your screens array. Never reference a screen id that isn't in your screens list.
- Include realistic, specific placeholder content (names, prices, statuses) relevant to the app's domain — not lorem ipsum.
- Include a tabbar component on every "main" screen (the ones reachable from other main screens) for realistic, consistent navigation, with 3-5 items.
- Keep each screen to 6-14 components so it fits a phone screen reasonably.
- The first screen in the array should match startScreen.
- Use "card" and "image_banner" components generously wherever a real app would show a photo (food items, properties, profile pictures, product photos, workout scenes, travel destinations, etc.) — this is a photo-realistic mockup, not an icon-based wireframe. Every image_query must be a concrete, photographable real-world subject (2-4 words), never an abstract concept, emoji description, or icon name.
- On any cart, order, or checkout screen with individual line items (food orders, shopping carts, multi-item bookings), use "quantity_stepper" for each item instead of a plain list_row — it renders real +/- controls, which reads as a genuinely interactive cart rather than a static list.
- When a screen shows a rating (restaurant rating, driver rating, product rating, provider rating), use a "stat" component with the value formatted exactly as "4.8 stars" — this triggers a real star-icon rendering instead of plain text.
- Use "avatar" for any person's profile picture (user avatars, driver photos, reviewer photos, doctor photos, etc.) instead of a generic icon.
- Home/feed/list screens should typically have 3-5 image-bearing cards; detail screens should typically open with a large image_banner.

Output ONLY the JSON object, nothing else.`;

const CONCISE_ADDENDUM = `

IMPORTANT ADDITIONAL CONSTRAINT: Your previous attempt at this ran out of space before finishing. This time, be more concise: use exactly 5 screens, keep each screen to 6-8 components maximum, and keep all text fields short. Prioritize finishing the JSON completely over including every detail.`;

const EDIT_SYSTEM_PROMPT = `You are a senior product designer adding a new feature to an EXISTING mobile app prototype. You will be given the current prototype as JSON, and a plain-English description of a feature to add.

CRITICAL RULES — these are non-negotiable:
- You MUST keep every existing screen's "id" exactly as it is. NEVER rename, remove, or merge an existing screen id.
- You MUST keep every existing screen's existing components — you may ADD new components to an existing screen (e.g. a new button or tab linking to the new feature), but never delete or rewrite content that was already there.
- You MAY add brand new screens for the new feature.
- You MAY add new navTo links from existing screens/tabbars to the new screens, to make the new feature reachable.
- Do not change appName or primaryColor unless the requested feature specifically implies a rebrand (it almost never does — leave them as-is).

Respond with ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "isValidAppIdea": true,
  "appName": "same as before unless truly warranted",
  "primaryColor": "same as before unless truly warranted",
  "screens": [ ...ALL original screens (unchanged except possibly new components added), PLUS any new screens for the feature... ],
  "startScreen": "same as before"
}

Use the same component schema as before: header, text, card (with image_query), button, input, quantity_stepper (title, subtitle, quantity), list_row, stat, tabbar, image_banner (with image_query, full_bleed), avatar (with image_query, size), map_placeholder, divider, spacer. Every image_query must be a concrete, photographable real-world subject (2-4 words). For star ratings, format the stat value as "4.8 stars" exactly, not just "4.8".

If the requested feature is too vague or nonsensical to add (e.g. "make it better" or "idk something cool"), respond instead with:
{"isValidAppIdea": false, "reason": "...", "suggestion": "a concrete feature example, phrased as a ready-to-use request"}

Output ONLY the JSON object, nothing else.`;

// Verifies that an edited prototype didn't lose or rename any screen that
// existed in the original. This is the one check that actually matters for
// "add a feature" requests — an LLM re-generating a large JSON blob can
// easily rename a screen id in passing, which would silently break every
// button that pointed to it (our dangling-nav safety net would "fix" that
// by redirecting to Home, which is a silently WRONG result, not a crash).
// Rejecting the whole edit and telling the user plainly beats that.
function editPreservesOriginalScreens(originalScreens, newScreens) {
  const originalIds = new Set((originalScreens || []).map((s) => s.id));
  const newIds = new Set((newScreens || []).map((s) => s.id));
  const missing = [...originalIds].filter((id) => !newIds.has(id));
  return { valid: missing.length === 0, missingIds: missing };
}

// Resolves every image_query in the prototype to a real, content-matching
// photo URL via the Pexels API. Deduplicates identical queries so a prompt
// with (say) "margherita pizza" used on 3 cards only costs 1 Pexels call,
// not 3. If Pexels fails entirely (missing key, rate limit, network issue),
// falls back to a neutral placeholder rather than failing the whole request
// — a slightly generic image beats no prototype at all.
async function resolveImages(screens, pexelsApiKey) {
  if (!pexelsApiKey) return; // no key configured — leave image_query as-is, frontend will show a placeholder

  const queries = new Set();
  for (const s of screens) {
    for (const c of s.components || []) {
      if (c.image_query && !c.resolved_image_url) queries.add(c.image_query);
    }
  }
  if (queries.size === 0) return;

  const resolved = new Map();
  await Promise.all(
    [...queries].map(async (q) => {
      try {
        const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(
          q
        )}&per_page=1&orientation=square`;
        const res = await fetch(url, {
          headers: { Authorization: pexelsApiKey },
        });
        if (!res.ok) return; // leave unresolved on failure, handled below
        const data = await res.json();
        const photo = data?.photos?.[0];
        if (photo?.src?.large) {
          resolved.set(q, photo.src.large);
        }
      } catch (e) {
        // network error on this one query — leave unresolved, fallback applies
      }
    })
  );

  const FALLBACK_IMG =
    "https://images.pexels.com/photos/1591056/pexels-photo-1591056.jpeg?auto=compress&cs=tinysrgb&w=600";

  for (const s of screens) {
    for (const c of s.components || []) {
      if (c.image_query && !c.resolved_image_url) {
        c.resolved_image_url = resolved.get(c.image_query) || FALLBACK_IMG;
      }
    }
  }
}

// Attempts to repair JSON that was cut off mid-structure (a common symptom of
// hitting the model's output token limit). Truncation almost always happens
// at a clean nesting boundary, so counting open vs. closed brackets/braces
// and closing whatever's left open recovers a valid, if slightly shorter,
// object in the large majority of cases.
function repairTruncatedJSON(text) {
  let s = text.trim();

  // Trim any trailing partial token (e.g. a dangling comma, an incomplete
  // string, or a key with no value yet) back to the last safe boundary.
  const lastSafe = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (lastSafe > 0 && lastSafe < s.length - 1) {
    // There's content after the last complete structure — likely a partial
    // trailing element. Try repairing from here first.
  }

  // Count unmatched brackets/braces, respecting string literals so we don't
  // count braces that appear inside quoted text.
  let stack = [];
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  let repaired = s;

  // If we ended mid-string, close the string first.
  if (inString) repaired += '"';

  // If the last non-whitespace character suggests a dangling comma or an
  // incomplete key/value, trim back to the last complete element.
  repaired = repaired.replace(/,\s*$/, "");
  repaired = repaired.replace(/:\s*$/, ": null");

  // Close any remaining open brackets/braces in reverse order.
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === "{" ? "}" : "]";
  }

  return repaired;
}

// Calls Gemini's native generateContent endpoint once and returns the raw
// text response. Throws on network/API failure.
async function callGemini(apiKey, model, promptText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const geminiRes = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 8000,
        responseMimeType: "application/json",
      },
    }),
  });

  const data = await geminiRes.json();

  if (!geminiRes.ok) {
    const err = new Error(data?.error?.message || "Gemini API request failed");
    err.statusCode = geminiRes.status;
    throw err;
  }

  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return text;
}

// Cleans markdown fences and attempts to parse JSON, falling back to
// bracket-repair if the response was truncated mid-structure.
function parseModelJSON(rawText) {
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/, "")
    .trim();

  try {
    return { parsed: JSON.parse(cleaned), wasRepaired: false };
  } catch (e) {
    // First fallback: extract the outermost { ... } block in case there's
    // stray text around it, then try parsing that directly.
    const match = cleaned.match(/\{[\s\S]*\}/);
    const candidate = match ? match[0] : cleaned;
    try {
      return { parsed: JSON.parse(candidate), wasRepaired: false };
    } catch (e2) {
      // Second fallback: attempt structural repair of truncated JSON.
      try {
        const repaired = repairTruncatedJSON(candidate);
        return { parsed: JSON.parse(repaired), wasRepaired: true };
      } catch (e3) {
        return { parsed: null, wasRepaired: false };
      }
    }
  }
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
  const pexelsApiKey = process.env.PEXELS_API_KEY; // optional — falls back to placeholder images if not set
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Server is missing GEMINI_API_KEY. Set it in Netlify site environment variables.",
      }),
    };
  }

  let prompt;
  let existingPrototype = null;
  try {
    const body = JSON.parse(event.body || "{}");
    prompt = (body.prompt || "").trim();
    existingPrototype = body.existingPrototype || null;
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  if (!prompt) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing 'prompt' field" }),
    };
  }

  if (prompt.length > 2000) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Prompt too long (max 2000 characters)" }),
    };
  }

  const isEditMode = !!(
    existingPrototype &&
    Array.isArray(existingPrototype.screens) &&
    existingPrototype.screens.length > 0
  );

  const model = "gemini-3.5-flash";
  const basePromptText = isEditMode
    ? `${EDIT_SYSTEM_PROMPT}\n\nExisting prototype:\n${JSON.stringify(
        existingPrototype
      )}\n\nFeature to add: ${prompt}`
    : `${SYSTEM_PROMPT}\n\nApp idea: ${prompt}`;

  try {
    // Attempt 1: normal generation.
    let rawText = await callGemini(apiKey, model, basePromptText);
    let { parsed, wasRepaired } = parseModelJSON(rawText);

    // Decide whether what we have is actually usable. Parsing can "succeed"
    // via bracket-repair yet still leave us with too little to render (e.g.
    // the truncation cut off nearly everything). Treat that the same as a
    // parse failure for retry purposes.
    function isUsable(p) {
      if (!p || typeof p.isValidAppIdea !== "boolean") return false;
      if (p.isValidAppIdea === false) return true; // valid "not an app idea" response
      const screens = Array.isArray(p.screens)
        ? p.screens.filter((s) => s && s.id && Array.isArray(s.components) && s.components.length > 0)
        : [];
      return screens.length >= 3; // need enough screens for a usable prototype
    }

    // Attempt 2 (silent, automatic): if the first attempt didn't produce a
    // usable result — whether from a hard parse failure or from truncation
    // that repair could only partially rescue — retry once with an explicit
    // instruction to be more concise. The person never sees this happen; it
    // just looks like a normal (if slightly slower) generation.
    if (!isUsable(parsed)) {
      rawText = await callGemini(apiKey, model, basePromptText + CONCISE_ADDENDUM);
      ({ parsed, wasRepaired } = parseModelJSON(rawText));
    }

    if (!isUsable(parsed)) {
      throw new Error(
        "That idea generated a longer response than usual and didn't come through cleanly. Please try again, or simplify the description a little."
      );
    }

    if (typeof parsed.isValidAppIdea !== "boolean") {
      throw new Error("Model response was missing the isValidAppIdea field");
    }

    if (parsed.isValidAppIdea === false) {
      // Not an app idea — return a friendly, structured "try again" response.
      // This is a normal, expected outcome, not an error condition.
      return {
        statusCode: 200,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          isValidAppIdea: false,
          reason: parsed.reason || "That doesn't look like an app idea yet.",
          suggestion:
            parsed.suggestion ||
            "Try something like: a food delivery app with live order tracking",
        }),
      };
    }

    // isValidAppIdea === true from here on — validate it's a usable prototype.
    if (
      !parsed.screens ||
      !Array.isArray(parsed.screens) ||
      parsed.screens.length === 0 ||
      !parsed.startScreen
    ) {
      throw new Error("Generated prototype was missing required fields");
    }

    // EDIT MODE ONLY: verify no original screen was renamed or dropped.
    // This is the one check that actually protects against the realistic
    // failure mode of "add a feature" edits — an LLM re-generating a large
    // JSON blob can rename a screen id in passing, which would silently
    // break every existing button that pointed to it. Our dangling-nav
    // safety net further below would "fix" that by redirecting to Home,
    // which is a silently WRONG result, not a crash — so we catch it here
    // instead and tell the person plainly rather than serve something subtly
    // broken.
    if (isEditMode) {
      const integrity = editPreservesOriginalScreens(
        existingPrototype.screens,
        parsed.screens
      );
      if (!integrity.valid) {
        throw new Error(
          "That edit would have changed part of your existing prototype in a way we couldn't verify as safe, so nothing was changed. Please try rephrasing the feature request, or try again."
        );
      }
    }

    // If repair had to trim the tail of the screens array, the last screen
    // may be incomplete (missing components, etc). Drop any screen that
    // doesn't have a usable components array so nothing renders broken.
    if (wasRepaired) {
      parsed.screens = parsed.screens.filter(
        (s) => s && s.id && Array.isArray(s.components)
      );
      if (parsed.screens.length === 0 || !parsed.screens.some((s) => s.id === parsed.startScreen)) {
        parsed.startScreen = parsed.screens[0]?.id;
      }
      if (!parsed.startScreen) {
        throw new Error(
          "That idea generated a longer response than usual and didn't come through cleanly. Please try again, or simplify the description a little."
        );
      }
    }

    // Safety net: redirect any dangling navTo/navMap references to the start
    // screen, so a malformed model response never produces a dead button.
    const validIds = new Set(parsed.screens.map((s) => s.id));
    for (const s of parsed.screens) {
      for (const c of s.components || []) {
        if (c.navTo && !validIds.has(c.navTo)) c.navTo = parsed.startScreen;
        if (c.navMap) {
          for (const k of Object.keys(c.navMap)) {
            if (!validIds.has(c.navMap[k])) c.navMap[k] = parsed.startScreen;
          }
        }
      }
    }

    // Resolve every image_query to a real, content-matching photo before
    // sending the prototype to the browser. This is what fixes the
    // "deer photo for an e-commerce app" problem — the browser no longer
    // guesses an image from the query text, it receives an already-correct
    // photo URL that Pexels matched to the actual query.
    await resolveImages(parsed.screens, pexelsApiKey);

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    return {
      statusCode: err.statusCode || 502,
      headers,
      body: JSON.stringify({ error: err.message || "Failed to generate prototype" }),
    };
  }
};
