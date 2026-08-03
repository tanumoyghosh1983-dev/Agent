// Netlify Function: capture-lead.js
// The piece that actually closes the loop: takes the prospect's contact
// details plus a snapshot of what they built (idea, estimate, deal link),
// stores the lead in Netlify Blobs, and — if a webhook is configured —
// pushes a formatted notification to the sales team in real time.
//
// LEAD_WEBHOOK_URL (optional) can be a Slack Incoming Webhook, a Zapier /
// Make catch hook, or any endpoint that accepts a JSON POST. If it's a
// Slack webhook (hooks.slack.com), we send Slack's {text:...} shape;
// otherwise we send the full structured lead object. If no webhook is set,
// the lead is still stored and can be listed later.

const { connectLambda, getStore } = require("@netlify/blobs");

// Deliberately permissive but real: rejects the obvious garbage without
// pretending to fully validate deliverability (only a sent email does that).
function looksLikeEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function fmtMoney(n) {
  if (typeof n !== "number") return "—";
  return "$" + Math.round(n).toLocaleString();
}

async function notifySales(lead, deal) {
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) return { notified: false, reason: "no webhook configured" };

  const dealLine = deal.dealUrl ? `\nDeal room: ${deal.dealUrl}` : "";
  const estLine = deal.estimate
    ? `\nEstimate: ${fmtMoney(deal.estimate.total)} · ${
        deal.estimate.timeline || ""
      } · ${deal.estimate.recommendedPackage?.name || ""}`
    : "";

  const summary =
    `🚀 New VE Copilot lead\n` +
    `Name: ${lead.name || "—"}\n` +
    `Email: ${lead.email}\n` +
    (lead.company ? `Company: ${lead.company}\n` : "") +
    `Idea: ${deal.idea || "—"}` +
    estLine +
    dealLine +
    (lead.notes ? `\nNotes: ${lead.notes}` : "");

  const isSlack = /hooks\.slack\.com/i.test(url);
  const payload = isSlack
    ? { text: summary }
    : { source: "ve-copilot", lead, deal, summary };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { notified: res.ok, status: res.status };
  } catch (err) {
    // A failing webhook must never fail the capture — the lead is already
    // stored, and losing the notification is recoverable, losing the lead
    // is not.
    return { notified: false, reason: err.message };
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

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  const email = (body.email || "").toString().trim();
  if (!looksLikeEmail(email)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Please enter a valid email address." }),
    };
  }

  const lead = {
    name: (body.name || "").toString().slice(0, 200),
    email,
    company: (body.company || "").toString().slice(0, 200),
    notes: (body.notes || "").toString().slice(0, 2000),
  };

  const deal = {
    idea: (body.idea || "").toString().slice(0, 2000),
    estimate: body.estimate || null,
    dealId: (body.dealId || "").toString().slice(0, 40),
    dealUrl: (body.dealUrl || "").toString().slice(0, 500),
  };

  const record = {
    lead,
    deal,
    createdAt: new Date().toISOString(),
    userAgent: event.headers?.["user-agent"] || null,
  };

  let stored = false;
  try {
    connectLambda(event);
    const store = getStore("leads");
    // Key by timestamp + a little entropy so leads sort chronologically and
    // never collide.
    const key =
      new Date().toISOString().replace(/[:.]/g, "-") +
      "_" +
      Math.random().toString(36).slice(2, 6);
    await store.setJSON(key, record);
    stored = true;
  } catch (err) {
    // Storage failed — still try to notify so the lead isn't lost entirely,
    // then report a soft success so the prospect's experience isn't broken.
    console.log("[capture-lead] store error:", err.message);
  }

  const notify = await notifySales(lead, deal);

  return {
    statusCode: 200,
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, stored, notified: notify.notified }),
  };
};
