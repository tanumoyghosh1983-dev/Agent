# Case Study Agent

Paste raw text and get a **finished, illustrated case study**, rendered into
**one fixed page template** — the exact structure and design approved in
Figma — every time. Preview it and download it as a single self-contained
HTML file.

It's a pipeline of specialized agents:

1. **Writer agent — OpenAI.** Turns raw input into content in ONE fixed
   format: headline, meta line, quick snapshot, story section, project/
   challenge cards, solution summary, a feature grid, a results grid, an
   optional tech-stack table, an optional testimonial, and a closing CTA —
   the same slots every time, filled from your source text.
2. **Design agent — Claude (Anthropic).** The page layout, typography, and
   black/white/teal brand system are fixed in the template and never change.
   What Claude decides, within that fixed template, is art direction: which
   icon (from a fixed 24-icon set) best represents each card, and what the
   supporting photography and product-screen imagery should depict.
3. **Illustrator agent — OpenAI images.** Renders the design agent's image
   prompts — hero photo, a secondary supporting image, and 2-4 solution
   screens — embedded as base64 (no image hosting, no broken links).
4. **Renderer — deterministic.** Injects content + icon choices + images into
   the single fixed template. Structure, layout, and colors never vary
   between case studies — only the copy, the icon choices, and the images do.

## Why this shape

Splitting *content* (fixed format) from *design* (fixed template) into
separate agents is what enforces consistency. The writer can't drift the
structure; the design agent can't touch layout, color, or type — it only
picks from a bounded, approved icon set and writes image prompts. Two very
different inputs still produce two case studies that look like they came out
of the same design system.

## Deliberate deviations from the source design

A few elements in the approved Figma couldn't be carried over faithfully
without breaking the tool's grounding guarantees, so they were adapted:

- **The 5-tab feature switcher** renders as one static feature grid (2-4
  items). Populating 5 real, distinct tab categories from a single raw-text
  input would mean inventing content that isn't in the source.
- **The "Other Case Studies" cross-link section** is dropped. There's no
  library of other generated case studies to link to, and nothing should be
  fabricated to fill that space.
- **The testimonial photo is an initials avatar, not an AI-generated face.**
  Generating a photorealistic image of a specific named real person (the
  quote's author) would fabricate that person's likeness. The design agent is
  explicitly instructed never to prompt for a named individual's photo.
- **The tech-stack table only renders when the source names real
  technologies.** No guessed stack, ever — same grounding rule already
  applied to metrics and quotes.
- **Slider dots under the story image row are static, not a working
  carousel.** The source design uses a real slider component there; this
  renders the same visual dots without the interactivity, since a one-shot
  generated page doesn't have more than the two images to cycle through.

## Values pulled directly from the Figma file (confirmed, not estimated)

Read from the file's Design panel: 100px section padding, 24px corner radius
on cards, 48px gap in the solution-screens row, and a pure `#000000` hero
background — all baked into the template as exact values. Two things are
still a best-effort visual match rather than confirmed values: the **teal
accent hex** and the **font family** (defaulted to Inter). Both are set once,
as CSS custom properties / a single `<link>` tag near the top of
`buildHTML()` in `public/index.html` — swap them there if you get the real
values later.

## How it's structured

```
public/index.html                     → the app (input, 4-stage pipeline, preview, download)
                                         includes the fixed template's HTML/CSS and the
                                         24-icon inline SVG library
netlify/functions/
  generate-content.js                 → OpenAI writer: raw text → fixed-format content
  design-casestudy.js                 → Claude design agent: content → icon + image art direction
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

- **Consistency is enforced in code, not just prompts.** The writer's output
  is normalized to the fixed schema (array lengths clamped, required pairs
  filtered). The design agent's icon choices are clamped to the fixed
  24-key set and padded/truncated to match each content array's length
  exactly — a bad or missing icon key can never leak into the render.
- **No fabrication.** The writer uses only facts, numbers, technologies, and
  quotes present in your input. If there's no named tech stack, the tools
  table is omitted; if there's no real quote, the testimonial is omitted.
  Feed it real material.
- **Images never block the page.** They render in parallel while you already
  see the full layout; a failed or slow image falls back to a tasteful
  placeholder instead of erroring.
- **Serverless timeouts.** A run generates up to 6 images (hero, secondary,
  2-4 solution screens) — the slow step. On plans that cap functions at 10s,
  set `OPENAI_IMAGE_QUALITY=low`. The design agent runs Claude at low effort
  to stay comfortably inside the function window.
