const TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/+esm";

export const DIRECTIONS = {
  "en-vi": { label: "Anh → Việt", model: "Xenova/opus-mt-en-vi" },
  "vi-en": { label: "Việt → Anh", model: "Xenova/opus-mt-vi-en" },
};

let tfPromise = null;
async function getTF() {
  if (!tfPromise) {
    tfPromise = import(/* @vite-ignore */ TF_URL).then((m) => {
      m.env.allowLocalModels = false;
      m.env.useBrowserCache = true;
      try {
        const isolated = typeof self !== "undefined" && self.crossOriginIsolated;
        m.env.backends.onnx.wasm.numThreads = isolated
          ? Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4))
          : 1;
      } catch {
        /* ignore */
      }
      return m;
    });
  }
  return tfPromise;
}

const pipes = new Map();

function makeReporter(onProgress) {
  let lastFile = "";
  let lastPct = -1;
  return (ev) => {
    if (!onProgress || !ev) return;
    if (ev.status === "progress" && ev.file && ev.file.endsWith(".onnx")) {
      const pct = Math.round(ev.progress || 0);
      if (ev.file !== lastFile || pct !== lastPct) {
        lastFile = ev.file;
        lastPct = pct;
        onProgress({ file: ev.file, ratio: (ev.progress || 0) / 100 });
      }
    }
  };
}

export async function ensureTranslator(dir, onProgress) {
  const cfg = DIRECTIONS[dir];
  if (!cfg) throw new Error(`Chưa hỗ trợ cặp ngôn ngữ: ${dir}`);
  if (pipes.has(cfg.model)) return pipes.get(cfg.model);
  const { pipeline } = await getTF();
  const promise = pipeline("translation", cfg.model, {
    dtype: "q8",
    progress_callback: makeReporter(onProgress),
  });
  pipes.set(cfg.model, promise);
  try {
    return await promise;
  } catch (err) {
    pipes.delete(cfg.model);
    throw err;
  }
}

// MarianMT dịch rất kém với chuỗi IN HOA toàn bộ -> hạ về dạng câu thường.
function normalizeForMT(text) {
  const t = String(text).trim();
  const letters = t.replace(/[^A-Za-zÀ-ỹ]/g, "");
  if (letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    let lower = t.toLowerCase();
    lower = lower.replace(/(^\s*[a-zà-ỹ])|([.!?]\s+[a-zà-ỹ])/g, (m) => m.toUpperCase());
    if (!/[.!?…]$/.test(lower)) lower += ".";
    return lower;
  }
  return t;
}

export async function translateBatch(texts, dir, onProgress) {
  const translator = await ensureTranslator(dir, onProgress);
  if (!texts.length) return [];
  const inputs = texts.map(normalizeForMT);
  const out = await translator(inputs, { max_length: 512 });
  return out.map((o) => (o.translation_text || "").trim());
}

export async function warmup(dir, onProgress) {
  await ensureTranslator(dir, onProgress);
}
