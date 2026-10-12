# Manga Translator

🇬🇧 English · [🇻🇳 Tiếng Việt](./README.md)

A manga/comic translator that runs **entirely in your browser**: it detects speech bubbles / text boxes, runs OCR, erases the original text with AI (inpainting), translates, lets you typeset the translation, and exports images. Your images never leave your machine (unless you enable Gemini translation).

## Features

- **Bubble & text detection** with the RT-DETR v2 model (ONNX, client-side).
- **OCR** (Tesseract.js) per region, with image preprocessing (grayscale + Otsu) for cleaner comic text.
- **AI text removal** via LaMa manga (inpainting), preserving line art / bubble borders.
- **Translation**:
  - Offline & free (Transformers.js — opus-mt English↔Vietnamese).
  - Or **Gemini API** (reads the text and translates with context) — optional, needs an API key.
- **Compare frame** original | translated, zoom into a single region (double-click a box).
- **Page list** with natural sort and a status badge per page (not detected / untranslated / in progress / translated). Click a status badge to **filter** the list.
- **Quick text-style presets**: save a style (font, size, weight, color, alignment, outline, plus optional prefix/suffix characters) and apply it to a region in one click. The active preset is highlighted; click it again to revert to the shared style.
- **Undo / redo**.
- **Add images**: from disk, from a direct image URL, or from a **chapter URL** (fetched through Jina Reader, images extracted in order).
- **Auto-save project** (IndexedDB), import/export `.mtproj`, export PNG / ZIP.
- Vietnamese-friendly fonts, light/dark theme, shared + per-region text styling.

## Tech stack

- Vanilla JavaScript (ES Modules), Canvas 2D, no build step.
- **ONNX Runtime Web** (WASM, multi-threaded, proxy worker): RT-DETR (detect) + LaMa (inpaint).
- **Tesseract.js** (OCR), **Transformers.js** (offline translation), **JSZip**.
- Optional **Google Gemini API** (REST) and **Jina Reader** (chapter HTML extraction).

## Run locally

Requires Node.js ≥ 20.

```bash
npm run serve
# open http://localhost:5173
```

The static server (`scripts/serve.mjs`) sets **COOP/COEP** headers to enable multi-threaded WASM (faster). On another server without those headers the tool still works, just slower.

## First run

- Models (detect ~11MB, inpaint ~60MB) are **downloaded once** and cached by the browser.
- Offline translation downloads the opus-mt model (~100MB) on first use.
- To use Gemini: get an API key at Google AI Studio → menu **⋯ → Translation source: Gemini** → paste the key (stored locally).

## Notes

- Images can only be added via a **direct image URL** or a chapter URL through Jina; the host must allow CORS (there is a fallback image proxy).
- Some sites using advanced Cloudflare, signed/expiring URLs, or complex JS galleries may not be extractable.
- Respect copyright: personal / study use only.

## Deploy (e.g. Firebase Hosting)

Set the COOP/COEP headers to keep multi-threading, e.g. `firebase.json`:

```json
{
  "hosting": {
    "public": ".",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "headers": [
      {
        "source": "**",
        "headers": [
          { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
          { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
        ]
      }
    ]
  }
}
```

## License

MIT — see [LICENSE](./LICENSE).
