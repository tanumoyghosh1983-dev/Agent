// Netlify Function: estimate.js
// Turns a set of build selections (category, platform, scope, chosen
// features / AI capabilities) into a deterministic cost + timeline + tier +
// recommended package. No API key needed — this is pure business logic built
// on the same CATEGORIES / PACKAGE_TIERS data the brochure estimator uses,
// so the number a prospect sees here matches the number sales quotes from.
//
// It is intentionally NOT an LLM call: pricing must be reproducible and
// defensible, not creative.

const { CATEGORIES } = require("./categories-extract.js");
const { PACKAGE_TIERS } = require("./packages-extract.js");

// Base engineering cost for building the shell of the app (auth, navigation,
// state, release) before any category-specific work or add-on features.
const PLATFORM_BASE = { ios: 420, android: 420 };

// Scope multiplier applied to (platform base + category baseline). An MVP is
// the reference point; "basic" and "refined" widen surface area and polish.
const SIZE_MULT = { mvp: 1.0, basic: 1.4, refined: 1.9 };
const SIZE_LABEL = {
  mvp: "an MVP-scope app",
  basic: "a basic-scope app",
  refined: "a fully refined, polished app",
};

function tierFromTotal(total) {
  if (total > 0 && total < 1200) return "startup";
  if (total < 4500) return "growth";
  return "enterprise";
}

function timelineFromTotal(total) {
  if (total < 1200) return "1-4 weeks";
  if (total < 4500) return "5-10 weeks";
  return "10-20+ weeks";
}

// Mirror of the brochure's package picker: exclude packages that aren't a
// "build this from zero" match (audits, maintenance-only, launch-only,
// discovery-only), then pick within the tier by how much scope was added.
function pickPackage(tier, extrasCount) {
  const allPackages = PACKAGE_TIERS[tier] || PACKAGE_TIERS.startup;
  const EXCLUDE_PATTERNS =
    /rescue|audit|maintenance|support(?!\s+for)|launch and go-live|discovery and (architecture|prototype)|launch readiness|market launch|go-live/i;
  const packages = allPackages.filter((p) => !EXCLUDE_PATTERNS.test(p.name));
  const usable = packages.length > 0 ? packages : allPackages;
  const idx = Math.min(
    usable.length - 1,
    Math.floor((extrasCount / 12) * usable.length)
  );
  return usable[Math.max(0, idx)];
}

function computeEstimate(input) {
  const platform = Array.isArray(input.platform) ? input.platform : [];
  const size = input.size || "mvp";
  const categoryKey = input.category || "custom";
  const selectedLabels = Array.isArray(input.selectedLabels)
    ? input.selectedLabels
    : [];

  const category = CATEGORIES[categoryKey] || CATEGORIES.custom;

  // Cost of each selected feature / AI capability, looked up by label from
  // the category's own priced lists. Unknown labels contribute nothing
  // rather than guessing a price.
  const priceByLabel = new Map();
  for (const [label, cost] of [...category.features, ...category.ai]) {
    priceByLabel.set(label, cost);
  }
  let extrasSum = 0;
  const lineItems = [];
  for (const label of selectedLabels) {
    const cost = priceByLabel.get(label) || 0;
    extrasSum += cost;
    lineItems.push({ label, cost });
  }

  const platformBase =
    (platform.includes("ios") ? PLATFORM_BASE.ios : 0) +
    (platform.includes("android") ? PLATFORM_BASE.android : 0) ||
    PLATFORM_BASE.ios; // default to one platform if none chosen yet

  // Building both platforms shares work, so it isn't quite double — apply a
  // small bundle discount when both are selected.
  const bundleFactor = platform.length === 2 ? 0.85 : 1;

  const sizeMult = SIZE_MULT[size] || 1.0;
  const baseline = (platformBase * bundleFactor + category.add) * sizeMult;
  const total = Math.round(baseline + extrasSum);

  const tier = tierFromTotal(total);
  const timeline = timelineFromTotal(total);
  const pkg = pickPackage(tier, selectedLabels.length);

  const platformLabel =
    platform.length === 2
      ? "iOS and Android"
      : platform.includes("ios")
      ? "iOS"
      : platform.includes("android")
      ? "Android"
      : "your chosen platform";

  return {
    total,
    tier,
    timeline,
    platformLabel,
    sizeLabel: SIZE_LABEL[size] || "your app",
    categoryLabel: category.label,
    baseline: Math.round(baseline),
    extrasSum,
    lineItems,
    recommendedPackage: {
      name: pkg.name,
      price: pkg.price,
      timeline: pkg.timeline,
      screens: pkg.screens,
      best: pkg.best,
      included: pkg.included,
    },
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

  let input;
  try {
    input = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  try {
    const estimate = computeEstimate(input);
    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(estimate),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || "Failed to compute estimate" }),
    };
  }
};

module.exports.computeEstimate = computeEstimate;
