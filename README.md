# Question Maker

Drop in some PDFs of your notes, get a multiple-choice quiz back. Every
question is grounded in the source material — nothing made up.

Static site, no server. Your OpenAI API key stays in your own browser
and only ever leaves it to call OpenAI directly.

## How to use it

1. Open the site.
2. Click "Set / change API key" and paste an OpenAI API key. (See below
   if you don't have one.)
3. Drop one or more PDFs onto the upload area.
4. Pick a quiz length (10–50 questions).
5. Click **Generate Quiz**.
6. Click through the quiz — select an option, hit **Check Answer**,
   move on. The running total tracks your score.
7. Flag any bad question, hit **Regenerate Quiz** to get a fresh set
   from the same PDFs (flagged stems and already-used passages are
   excluded).

Re-uploading the same PDF is free — the extracted markdown is cached
in your browser's IndexedDB, keyed by file hash.

## Getting an OpenAI key

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
2. Sign up if you haven't already, and add a small amount of credit
   ($5 is plenty for hundreds of quizzes).
3. Create a new key starting with `sk-…` and copy it.
4. Paste it into the site once. It's stored in `localStorage` and never
   sent anywhere except to OpenAI.

**Cost**: about $0.005–$0.02 per quiz on `gpt-4o-mini` (the model this
app uses for both OCR and generation). A heavy day of studying is
typically well under $1.

**Tip**: in the OpenAI dashboard you can set a monthly spend cap on
your key — recommended.

## What's under the hood

- **PDF text extraction**: [pdf.js](https://mozilla.github.io/pdf.js/)
  (vendored under `vendor/pdfjs/`) extracts the text layer page by
  page, fully in the browser.
- **OCR fallback**: pages with no text layer are rendered to canvas
  and sent to `gpt-4o-mini` (vision) for transcription.
- **Question generation**: the combined markdown is split into
  ~3500-character chunks. Each chunk is sent to OpenAI with a strict
  prompt that requires the correct answer's key phrase to appear in
  the passage. After parsing, a heuristic grounding check drops any
  question whose correct answer doesn't substantially overlap with the
  source chunk.
- **Caching**: extracted markdown is stored per-file in IndexedDB
  (keyed by SHA-1 of the PDF), so re-uploads are instant and OCR isn't
  re-run.
- **Regenerate**: used chunk IDs and flagged question stems are
  carried forward so re-generated quizzes pull from new material and
  avoid repeats.

## Privacy

- Your API key never leaves your browser, except in requests directly
  to `api.openai.com`.
- Uploaded PDFs are processed entirely client-side. Only the OCR
  pathway sends any content to OpenAI (and only the pages without a
  text layer).
- Nothing is logged or stored on any server.

## Files

```
index.html        # upload + quiz views
app.js            # orchestration
extract.js        # pdf.js → markdown + IndexedDB cache
ocr.js            # OCR fallback via OpenAI vision
generate.js       # chunking, prompting, grounding check
quiz.js           # quiz view rendering + interactions
styles.css        # styling
vendor/pdfjs/     # vendored pdf.js library files
```

## Deploying to GitHub Pages

This is a static site. To put it online:

1. Push to a public GitHub repo (already done if you're reading this).
2. Repo **Settings → Pages → Source**: pick the branch you want to
   serve, root directory.
3. Site goes live at `https://<your-username>.github.io/<repo>/` in a
   couple of minutes.

No build step. No environment variables.

## Local development

Open a terminal in the project directory and run any static server:

```sh
python3 -m http.server 8765
```

Then visit `http://localhost:8765`. Don't open `index.html` directly
via `file://` — modules need an HTTP origin.
