# Case Study Agent

Paste raw text and get a **finished, illustrated case study** — where every
case study comes out in **one fixed content format** and **one fixed design
template**, so they're consistent every time. Preview it and download it as a
single self-contained HTML file.

It's a pipeline of specialized agents:

1. **Writer agent — OpenAI.** Turns raw input into content in ONE fixed format:
   the same fields and the same four canonical sections (challenge → approach →
   solution → results) every time. Makes no design decisions.
2. **Design agent — Claude (Anthropic).** Takes that content and produces a
   *design plan* for the ONE fixed template: the accent (chosen from an
   approved 8-color palette), the display headline, which metric to feature,
   art-direction prompts for the two image slots, and which quote to pull. It
   makes design *judgments* but cannot change the template — that's what keeps
   the design format consistent.
3. **Illustrator agent — OpenAI images.** Renders the design agent's image
   prompts, embedded as base64 (no image hosting, no broken links).
4. **Renderer — deterministic.** Injects content + design plan + images into
   the single fixed template. Same structure and typography every time; only
   the accent, the copy, and the two images vary.

## Why this shape

Splitting *content* (fixed format) from *design* (fixed template) into separate
agents is what enforces consistency. The writer can't drift the structure; the
design agent can't drift the layout — it only picks from bounded, approved
choices. Two very different inputs produce two case studies that look like they
belong to the same collection.

## How it's structured

```
public/index.html                     → the app (input, staged pipeline, preview, download)
netlify/functions/
  generate-content.js                 → OpenAI writer: raw text → fixed-format content
  design-casestudy.js                 → Claude design agent: content → design plan (one template)
  generate-image.js                   → OpenAI images: prompt → embedded base64 image
netlify.toml                          → Netlify config (static + functions)
package.json                          → zero dependencies (uses fetch)
```

Both API keys stay server-side — the browser calls the site's own functions.
The Anthropic Messages API is called with plain `fetch` (no SDK) to match this
project's zero-dependency serverless-proxy convention.

## Deploy (Netlify)

1. **Push this repo** and import it in Netlify ("Add new site" → "Import an
   existing project"). Settings auto-detect from `netlify.toml` — no build
   command; it's static HTML plus three functions.

2. **Set environment variables** (Site configuration → Environment variables):

   | Variable | Required | Default | Purpose |
   |---|---|---|---|
   | `OPENAI_API_KEY` | **Yes** | — | Writer agent + illustrator agent. |
   | `ANTHROPIC_API_KEY` | **Yes** | — | Design agent (Claude). |
   | `OPENAI_MODEL` | No | `gpt-4o` | Text model for the writer. |
   | `ANTHROPIC_MODEL` | No | `claude-opus-5` | Model for the design agent. |
   | `OPENAI_IMAGE_MODEL` | No | `gpt-image-1` | Image model. Set to `dall-e-3` if your account can't use `gpt-image-1`. |
   | `OPENAI_IMAGE_QUALITY` | No | `medium` | `low` \| `medium` \| `high` (gpt-image-1 only). Use `low` if your Netlify plan caps function runtime at 10s. |

## Notes on reliability

- **Consistency is enforced in code, not just prompts.** The writer's output is
  normalized to the fixed schema; the design agent's output is clamped to the
  approved palette, and its metrics and pull quote can only reference facts that
  exist in the content — so a case study can never show a fabricated number or a
  hallucinated colour.
- **No fabrication.** The writer uses only facts, numbers, and quotes present in
  your input; if there are no hard metrics it returns none, and it omits the
  quote when the source has none. Feed it real material.
- **Images never block the page.** They render in parallel while you already see
  the designed layout; a failed or slow image falls back to a tasteful accent
  gradient instead of erroring.
- **Serverless timeouts.** Image generation is the slow step; on plans that cap
  functions at 10s, set `OPENAI_IMAGE_QUALITY=low`. The design agent runs Claude
  at low effort to stay well inside the function window.
