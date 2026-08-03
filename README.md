# VE Copilot

**Idea → Prototype → Estimate → Build plan → Sales-ready lead**, in one flow.

VE Copilot is the closing machine that sits on top of VirtualEmployee.com's
existing prototype and estimate tools. A prospect types an app idea in plain
English and, without ever leaving the page, gets:

1. A **clickable phone prototype** (Gemini-generated, tap-through screens).
2. An **instant cost + timeline estimate**, priced from the same catalog the
   sales team quotes from — no guesswork, no "we'll get back to you".
3. A **build-ready specification** — screen-by-screen user stories, a data
   model, an API surface, integrations, and per-screen effort — that the
   delivery team can quote and start building against.
4. A **shareable deal room** (`/p.html?id=…`) bundling the prototype,
   estimate, and plan so a champion can forward it to their team.

And the part the standalone tools were missing: **the lead is captured and
pushed to sales in real time.** The prospect no longer generates something
beautiful and vanishes.

## How it's structured

```
public/index.html                  → the funnel (describe → prototype → estimate → plan)
public/p.html                      → shared read-only deal room
netlify/functions/
  generate.js                      → Gemini proxy: idea → prototype JSON (with image resolution)
  estimate.js                      → deterministic cost / timeline / tier / package
  spec.js                          → Gemini: prototype JSON → build-ready PRD
  catalog.js                       → serves the priced feature catalog to the frontend
  save-deal.js / get-deal.js       → persist + reopen a full deal (Netlify Blobs)
  capture-lead.js                  → store the lead + notify sales via webhook
  categories-extract.js            → category / feature / AI pricing data (source of truth)
  packages-extract.js              → package-tier data
netlify.toml                       → Netlify config (static + functions)
package.json                       → one dependency: @netlify/blobs
```

The browser never talks to Gemini directly — it calls the site's own
functions, which hold the API key server-side. Pricing is computed
server-side and is intentionally **not** an LLM call, so every number is
reproducible and defensible.

## Deploy (Netlify)

1. **Push this repo** and import it in Netlify ("Add new site" → "Import an
   existing project"). Build settings auto-detect from `netlify.toml` — no
   build command; it's static HTML plus functions.

2. **Set environment variables** (Site configuration → Environment variables):

   | Variable | Required | Purpose |
   |---|---|---|
   | `GEMINI_API_KEY` | **Yes** | Prototype + spec generation. Get one at [aistudio.google.com](https://aistudio.google.com). Both `AIza…` and `AQ.` key formats work. |
   | `PEXELS_API_KEY` | Optional | Resolves prototype images to real, content-matching photos. Without it, placeholder images are used. |
   | `LEAD_WEBHOOK_URL` | Optional | Where captured leads are pushed. A Slack Incoming Webhook gets a formatted message; any other URL receives the full lead JSON (Zapier / Make / your CRM). Without it, leads are still stored in Blobs. |

3. **Netlify Blobs** (used for saved deals and stored leads) is built into the
   platform — nothing to configure.

## The flow, end to end

```
 idea ──▶ generate.js ──▶ prototype (phone frame)
                              │
                              ▼
                         estimate.js ──▶ cost + timeline + package
                              │
                              ▼   (prospect enters email)
        ┌─────────────────────┴─────────────────────┐
        ▼                     ▼                       ▼
    spec.js             save-deal.js            capture-lead.js
  build-ready PRD    shareable deal room     lead stored + sales notified
```

## Notes

- Prototypes and estimates are directional — they're a top-of-funnel demo,
  refined during a real discovery call. The copy says so, on purpose.
- Reused, unchanged, from the existing tools: the prototype generator, the
  renderer, and the pricing data. VE Copilot is the layer that connects them
  and closes the loop.
