// Netlify Function: get-deal.js
// Retrieves a previously-saved deal (prototype + estimate + spec) by its
// short ID, so the deal room at /p.html?id=... can render the whole thing.

const { connectLambda, getStore } = require("@netlify/blobs");

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const id = event.queryStringParameters && event.queryStringParameters.id;
  if (!id || !/^[a-z0-9]{1,20}$/i.test(id)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing or invalid id parameter" }),
    };
  }

  try {
    connectLambda(event);
    const store = getStore("deals");
    const record = await store.get(id, { type: "json" });

    if (!record) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: "This link doesn't exist or has expired.",
        }),
      };
    }

    // Never expose the captured lead's contact details through the public
    // share link, even if a future version stores them on the deal record.
    if (record.lead) delete record.lead;

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(record),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message || "Failed to retrieve deal" }),
    };
  }
};
