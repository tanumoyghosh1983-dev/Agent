// Netlify Function: catalog.js
// Exposes the category / feature / AI-capability catalog to the frontend so
// the estimate configurator can render real, priced options without the
// client hard-coding (and drifting from) the pricing data. estimate.js reads
// the same CATEGORIES module, so there is exactly one source of truth.
//
// Prices themselves are intentionally NOT sent to the browser — the client
// only needs labels and keys to build the picker; the authoritative total is
// always computed server-side by estimate.js.

const { CATEGORIES } = require("./categories-extract.js");

exports.handler = async function () {
  const catalog = Object.entries(CATEGORIES).map(([key, c]) => ({
    key,
    label: c.label,
    features: c.features.map(([label]) => label),
    ai: c.ai.map(([label]) => label),
  }));

  return {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
    body: JSON.stringify({ categories: catalog }),
  };
};
