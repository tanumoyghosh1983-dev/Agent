# Case Study Agent

Paste raw text — notes, an email thread, a transcript, bullet points — and the
agent produces a **finished, designed, illustrated case study** you can preview
and download as a single self-contained HTML file. End to end, powered by the
**OpenAI API**.

It does four jobs, in order:

1. **Writes** the story — turns messy input into a structured case study
   (headline, overview, challenge → approach → solution → results, grounded
   metrics, pull quote).
2. **Art-directs** — picks an accent color, mood, and typeface that fit the
   story, and writes prompts for the imagery.
3. **Illustrates** — generates real images with OpenAI's image model and
   embeds them directly in the page.
4. **Designs** — lays it all out in a polished editorial template and gives you
   a downloadable `.html` file.

## How it's structured

```
public/index.html                     → the app (input, live preview, download)
netlify/functions/
  generate-casestudy.js               → OpenAI chat: raw text → structured case study + theme + image prompts
  generate-image.js                   → OpenAI images: one prompt → base64 image (embedded, no hosting needed)
netlify.toml                          → Netlify config (static + functions)
package.json                          → zero dependencies (uses fetch)
```

The browser never sees the OpenAI key — it calls the site's own functions,
which hold the key server-side. Generated images are returned as base64 and
inlined into the HTML, so the file you download is completely self-contained
(no broken image links, nothing to host).

## Deploy (Netlify)

1. **Push this repo** and import it in Netlify ("Add new site" → "Import an
   existing project"). Settings auto-detect from `netlify.toml` — no build
   command; it's static HTML plus two functions.

2. **Set environment variables** (Site configuration → Environment variables):

   | Variable | Required | Default | Purpose |
   |---|---|---|---|
   | `OPENAI_API_KEY` | **Yes** | — | Your OpenAI API key. Used by both functions. |
   | `OPENAI_MODEL` | No | `gpt-4o` | Text model that writes the case study. |
   | `OPENAI_IMAGE_MODEL` | No | `gpt-image-1` | Image model. Set to `dall-e-3` if your account can't use `gpt-image-1`. |
   | `OPENAI_IMAGE_QUALITY` | No | `medium` | `low` \| `medium` \| `high` (gpt-image-1 only). Use `low` if your Netlify plan caps function runtime at 10s. |

## Notes on reliability

- **Grounding:** the writer is instructed to use only facts, numbers, and
  quotes that appear in your input. If there are no hard metrics, it returns
  none rather than inventing them, and it omits the quote if the source has
  none. Always give it real material to work from.
- **Images never block the page.** They render in parallel while you already
  see the designed layout; if an image fails or times out, that spot falls
  back to a tasteful accent gradient instead of erroring.
- **Timeouts:** image generation is the slow step. On plans that cap functions
  at 10s, set `OPENAI_IMAGE_QUALITY=low`; on 26s plans, `medium` is fine.

## Local input tips

The richer the raw text, the better the result. Client name, the problem, what
you did, and concrete outcomes (with numbers, if you have them) give the agent
everything it needs. Try the **Use sample** button to see the shape of a good
input.
