# Case Study Agent

> This repo also contains a second, independent tool — the **Expert Interview
> Agent** — documented in its own section below.


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

---

# Expert Interview Agent

Turns a reluctant writer into a willing talker. Instead of asking an expert
to *write* documentation about a client project, this tool interviews them:
Claude asks one question at a time (and follow-ups when an answer leaves
something specific unexplored), the expert answers out loud, Whisper
transcribes it, and everything is saved. At the end, one click turns the raw
transcript into an organized Markdown documentation draft.

**Open `public/interview.html`** (e.g. `https://your-site.netlify.app/interview.html`).

## How it works

1. **Setup.** You enter the expert's name, the project name, and a topic
   outline (one topic per line — e.g. "the client and the problem",
   "technical approach", "obstacles", "outcome").
2. **Interview loop**, per question:
   - `interview-next-question.js` (Claude) looks at the outline + everything
     asked/answered so far and decides: ask a fresh question on the next
     topic, or fire a sharp follow-up on something specific the expert just
     mentioned. This is what pulls out detail an expert wouldn't think to
     write down themselves.
   - The question is shown on screen and read aloud (browser
     `speechSynthesis` — free, no API call).
   - The expert clicks **Record**, speaks their answer, clicks **Stop**.
   - `transcribe-answer.js` (OpenAI Whisper) transcribes the recording. The
     expert can edit the text before submitting if Whisper mis-heard
     something.
   - Repeats until Claude decides every topic is sufficiently covered, or the
     expert clicks **Finish interview now**.
3. **Save.** `save-session.js` stores the full transcript *and* every raw
   answer recording to **Netlify Blobs** (`interview-sessions` store) — no
   external account needed beyond the Netlify site itself. The expert can
   also **Download transcript (.json)** as a local backup.
4. **Draft documentation.** Click **Generate documentation draft** —
   `generate-doc.js` (Claude) turns the transcript into organized Markdown
   (grouped by topic, grounded strictly in what was said, with an "open
   questions / gaps" section) — download it as `.md` and hand it to whoever
   polishes the final doc.
5. **Review saved sessions later.** `list-sessions.js` lists every saved
   session (`GET /.netlify/functions/list-sessions`), fetches one session's
   full transcript by id (`?id=<id>`), or fetches one answer's raw audio
   (`?id=<id>&audio=<audioKey>`) — useful for building a simple internal
   review page later, or just to confirm sessions are landing in storage.

## How it's structured

```
public/interview.html                     → the interview UI (setup, Q&A loop, transcript, save, doc generation)
netlify/functions/
  interview-next-question.js              → Claude: outline + history → next question or follow-up
  transcribe-answer.js                    → OpenAI Whisper: recorded audio → transcript text
  save-session.js                         → Netlify Blobs: persist transcript + audio for one session
  list-sessions.js                        → Netlify Blobs: list/fetch saved sessions and audio
  generate-doc.js                         → Claude: full transcript → structured Markdown documentation draft
```

## What you need to provide

| What | Required | Notes |
|---|---|---|
| **`OPENAI_API_KEY`** | Yes | Used for Whisper transcription. Same env var the case study agent uses — if that's already set on this Netlify site, this works out of the box. |
| **`ANTHROPIC_API_KEY`** | Yes | Used for the interviewer (next-question) and the doc-writer agent. Same var the case study agent uses. |
| **Netlify Blobs** | Usually no setup needed | Enabled automatically on most Netlify sites/plans — see fallback below if you see a Blobs error. |
| `OPENAI_TRANSCRIBE_MODEL` | No | Defaults to `whisper-1`. |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-opus-5` (shared with the case study agent's setting). |
| `NETLIFY_SITE_ID` + `NETLIFY_BLOBS_TOKEN` | Only if you see a Blobs error | See below. |

Nothing else is required to run this end to end once those two keys are set
on the Netlify site (Site configuration → Environment variables) — the same
place the case study agent's keys already live.

### If saving fails with "environment has not been configured to use Netlify Blobs"

On some Netlify plans/deploy setups, Blobs' automatic mode isn't available and
needs two extra env vars as a manual fallback (downloading a transcript still
works either way — this only affects server-side auto-save):

1. **`NETLIFY_SITE_ID`** — Site configuration → General → Site details → Site ID (a UUID).
2. **`NETLIFY_BLOBS_TOKEN`** — a Personal Access Token: user avatar (top right on app.netlify.com) → User settings → Applications → New access token.

Add both as environment variables and redeploy. The interview functions pick
them up automatically (`netlify/functions/lib/blob-store.js`) — no code
changes needed.

## Honest limitations / things worth knowing before you rely on this

- **Browser mic access requires HTTPS** (or `localhost`) — this works fine
  on a deployed Netlify site, but won't work opening the HTML file directly
  from disk.
- **Per-answer audio upload is capped** at roughly 2 minutes per answer
  (Netlify's function request-body limit). Fine for focused Q&A; not meant
  for uninterrupted 20-minute monologues. If an expert wants to talk longer
  per topic, coach them to pause and let a follow-up question re-prompt them
  — that's actually the design intent, not a workaround.
- **Text-to-speech uses the browser's built-in voice** (no API cost), which
  sounds robotic on some systems/browsers. The question is always shown as
  text too, so this is a nice-to-have, not a dependency.
- **Whisper transcription costs a small per-minute fee** on your OpenAI
  account; Claude calls (one per question + one per doc generation) cost
  per-token. For a typical 20-30 minute interview this is cents, not
  dollars, but it isn't free.
- **The generated Markdown is a draft, not a finished document.** It's
  explicitly grounded to only what was said (no invented facts), which means
  it will sometimes read as incomplete — that's intentional; gaps are called
  out rather than papered over, and a human should still edit the final
  version.
- **No authentication.** Anyone with the `/interview.html` URL can run an
  interview, and anyone who can call the Netlify functions directly can
  list/read saved sessions. Fine for an internal, unlisted URL; if this
  needs to be locked down (e.g. Netlify Identity, a shared password gate),
  say so and it can be added.
