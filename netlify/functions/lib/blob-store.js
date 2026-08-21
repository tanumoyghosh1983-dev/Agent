// Shared helper: opens the "interview-sessions" Netlify Blobs store.
//
// getStore("name") alone relies on Netlify's automatic runtime context, which
// isn't always present (depends on plan/deploy path). If that context is
// missing, fall back to manual config using two env vars:
//   NETLIFY_SITE_ID     — Site configuration → General → Site details → Site ID
//   NETLIFY_BLOBS_TOKEN — a Personal Access Token: app.netlify.com/user/applications
// Both are optional — only needed if the automatic mode errors with
// "environment has not been configured to use Netlify Blobs".

const { getStore } = require("@netlify/blobs");

function openStore() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name: "interview-sessions", siteID, token });
  }
  return getStore("interview-sessions");
}

module.exports = { openStore };
