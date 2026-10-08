import { rect } from "./util.js";

const workers = new Map();
let currentLang = null;

function getTesseract() {
  const T = globalThis.Tesseract;
  if (!T) throw new Error("Không tìm thấy Tesseract.js (kiểm tra kết nối tới CDN).");
  return T;
}

async function getWorker(lang, onProgress) {
  if (workers.has(lang)) return workers.get(lang);
  const T = getTesseract();
  const worker = await T.createWorker(lang, 1, {
    logger: (m) => {
      if (m.status === "recognizing text") {
        onProgress?.({ phase: "ocr", ratio: m.progress });
      } else {
        onProgress?.({ phase: m.status, ratio: m.progress || 0 });
      }
    },
  });
  workers.set(lang, worker);
  return worker;
}

export function parseTsv(tsv) {
  const words = [];
  if (!tsv) return words;
  const rows = tsv.split("\n");
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i].split("\t");
    if (cols.length < 12) continue;
    const level = Number(cols[0]);
    if (level !== 5) continue;
    const conf = Number(cols[10]);
    const text = cols.slice(11).join("\t").trim();
    if (!text || conf < 0) continue;
    words.push({
      text,
      conf: conf / 100,
      ...rect(Number(cols[6]), Number(cols[7]), Number(cols[8]), Number(cols[9])),
    });
  }
  return words;
}

export async function recognize(image, { lang = "jpn", onProgress, psm = "3" } = {}) {
  const worker = await getWorker(lang, onProgress);
  currentLang = lang;
  try {
    await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: "1" });
  } catch {
    /* ignore */
  }
  const { data } = await worker.recognize(image, {}, { text: true, tsv: true });
  return { text: data.text || "", words: parseTsv(data.tsv) };
}

// Tiền xử lý: xám hoá + Otsu nhị phân (tự đảo nếu nền tối) -> giúp chữ truyện sạch hơn.
function preprocess(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const im = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = im.data;
  const n = canvas.width * canvas.height;
  const gray = new Uint8Array(n);
  let sum = 0;
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    gray[p] = g;
    sum += g;
  }
  const mean = sum / n;
  const invert = mean < 110; // nền tối -> đảo để chữ thành đen trên nền trắng
  const hist = new Array(256).fill(0);
  for (let p = 0; p < n; p++) {
    const g = invert ? 255 - gray[p] : gray[p];
    gray[p] = g;
    hist[g]++;
  }
  let total = n;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let maxVar = 0;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) {
      maxVar = v;
      thr = t;
    }
  }
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const v = gray[p] > thr ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
}

export async function ocrCanvas(image, crop, { lang = "jpn", padding = 6, onProgress } = {}) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  const x = Math.max(0, crop.x - padding);
  const y = Math.max(0, crop.y - padding);
  const w = Math.min(iw, crop.x + crop.w + padding) - x;
  const h = Math.min(ih, crop.y + crop.h + padding) - y;
  const scale = Math.max(1.5, Math.min(4, 620 / Math.max(1, Math.max(w, h))));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height);
  preprocess(canvas);
  const { text } = await recognize(canvas, { lang, onProgress, psm: "6" });
  return text.replace(/\s+/g, " ").trim();
}

export async function disposeWorkers() {
  for (const w of workers.values()) {
    try {
      await w.terminate();
    } catch {
      /* ignore */
    }
  }
  workers.clear();
}

export function getCurrentLang() {
  return currentLang;
}
