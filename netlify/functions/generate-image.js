// Netlify Function: generate-image.js
// The "illustrator" stage. Takes one image prompt and returns a generated
// image as a base64 data URL, ready to embed directly in the case study HTML
// (so the final page is fully self-contained — no external image hosting).
//
// Uses the OpenAI Images API. Key is server-side only (OPENAI_API_KEY).
// Works with both gpt-image-1 (default) and dall-e-3, which have slightly
// different request shapes — this function papers over the difference.
//
// Env:
//   OPENAI_IMAGE_MODEL   default "gpt-image-1" (alt: "dall-e-3")
//   OPENAI_IMAGE_QUALITY default "medium" for gpt-image-1 (use "low" to fit
//                        a 10s function timeout; dall-e-3 ignores this)

function sizeFor(model, orientation) {
  const isDalle = /dall-e/i.test(model);
  if (orientation === "landscape") return isDalle ? "1792x1024" : "1536x1024";
  if (orientation === "portrait") return isDalle ? "1024x1792" : "1024x1536";
  return "1024x1024";
}

async function generate(apiKey, model, prompt, orientation) {
  const isDalle = /dall-e/i.test(model);
  const size = sizeFor(model, orientation);

  const payload = { model, prompt, size, n: 1 };
  if (isDalle) {
    // dall-e-3 must be told to return base64; gpt-image-1 returns it by default
    // and rejects the response_format parameter.
    payload.response_format = "b64_json";
  } else {
    payload.quality = process.env.OPENAI_IMAGE_QUALITY || "medium";
  }

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || "Image generation failed");
    err.statusCode = res.status;
    throw err;
  }
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("Image API returned no image data");
  return `data:image/png;base64,${b64}`;
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

  let prompt, orientation;
  try {
    const body = JSON.parse(event.body || "{}");
    prompt = (body.prompt || "").toString().trim();
    orientation = ["landscape", "portrait", "square"].includes(body.orientation)
      ? body.orientation
      : "landscape";
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
      body: JSON.stringify({ error: "Missing image prompt" }),
    };
  }

  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";

  // Nudge the model away from rendering any text/logos, which image models do
  // poorly, and toward a clean editorial look that fits a case study.
  const styled =
    prompt +
    " — clean editorial photography / conceptual illustration, high quality, tasteful, no text, no words, no letters, no logos, no charts, no user interface.";

  try {
    const dataUrl = await generate(apiKey, model, styled, orientation);
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    };
  } catch (err) {
    return {
      statusCode: err.statusCode || 502,
      headers,
      body: JSON.stringify({
        error: err.message || "Failed to generate image",
      }),
    };
  }
};
