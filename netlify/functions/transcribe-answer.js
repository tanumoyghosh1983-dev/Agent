// Netlify Function: transcribe-answer.js
// Transcribes (and translates) one recorded answer using OpenAI's Whisper
// TRANSLATIONS endpoint (audio/translations, not audio/transcriptions). The
// expert can speak in whatever language they're comfortable in (English,
// Hindi, or a mix); this endpoint always returns English text, automatically,
// with no language selection or manual translation step needed anywhere in
// the app. The browser sends the recorded audio blob as base64; this
// function re-packages it as multipart/form-data (Whisper's API doesn't
// accept raw base64 or JSON) and returns the plain English text.
//
// Key is server-side only (OPENAI_API_KEY). Model defaults to whisper-1
// (currently the only model OpenAI's translations endpoint supports).

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
      body: JSON.stringify({ error: "Server is missing OPENAI_API_KEY. Set it in Netlify site environment variables." }),
    };
  }

  let audioBase64, mimeType;
  try {
    const body = JSON.parse(event.body || "{}");
    audioBase64 = body.audioBase64;
    mimeType = String(body.mimeType || "audio/webm");
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }
  if (!audioBase64) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing audioBase64" }) };
  }

  // Netlify functions cap request bodies around 6MB (base64 inflates ~33%);
  // reject early with a clear message rather than a confusing gateway error.
  if (audioBase64.length > 7_500_000) {
    return {
      statusCode: 413,
      headers,
      body: JSON.stringify({ error: "That answer's audio is too long for one upload. Try shorter answers (under ~2 minutes each)." }),
    };
  }

  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
  const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";

  try {
    const audioBuffer = Buffer.from(audioBase64, "base64");

    const boundary = "----ffmnetlifyboundary" + Date.now();
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`));
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="answer.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`
      )
    );
    parts.push(audioBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const multipartBody = Buffer.concat(parts);

    const res = await fetch("https://api.openai.com/v1/audio/translations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody,
    });

    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data?.error?.message || "OpenAI transcription request failed");
      err.statusCode = res.status;
      throw err;
    }

    const text = String(data.text || "").trim();
    return { statusCode: 200, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ text }) };
  } catch (err) {
    return { statusCode: err.statusCode || 502, headers, body: JSON.stringify({ error: err.message || "Failed to transcribe the answer." }) };
  }
};
