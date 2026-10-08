import { rect } from "./util.js";

const ORT_VERSION = "1.30.0";
const CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const DEFAULT_MODEL_URL =
  "https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector-v4-s_int8.onnx";

export const CLASSES = ["bubble", "text_bubble", "text_free"];
export const CLASS_LABEL_VI = {
  bubble: "bong bóng",
  text_bubble: "chữ trong bong bóng",
  text_free: "chữ ngoài bong bóng",
  manual: "vùng thủ công",
};

let ortReady = false;
let session = null;
let sessionPromise = null;
let modelBytes = null;

export function getOrt() {
  const ort = globalThis.ort;
  if (!ort) throw new Error("Không tìm thấy onnxruntime-web (kiểm tra kết nối tới CDN).");
  if (!ortReady) {
    const isolated = typeof self !== "undefined" && self.crossOriginIsolated;
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    ort.env.wasm.wasmPaths = CDN;
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = isolated ? Math.max(1, Math.min(8, cores)) : 1;
    ort.env.wasm.proxy = true;
    ort.env.logLevel = "error";
    if (typeof window !== "undefined") window.__ortThreads = ort.env.wasm.numThreads;
    ortReady = true;
  }
  return ort;
}

export async function fetchCached(url, onProgress) {
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open("mt-models");
      const hit = await cache.match(url);
      if (hit) {
        onProgress?.({ phase: "cache", ratio: 1 });
        return new Uint8Array(await hit.arrayBuffer());
      }
      const bytes = await fetchWithProgress(url, (r) => onProgress?.({ phase: "download", ratio: r }));
      try {
        await cache.put(
          url,
          new Response(bytes.slice().buffer, { headers: { "content-type": "application/octet-stream" } }),
        );
      } catch {
        /* cache đầy thì bỏ qua */
      }
      return bytes;
    } catch {
      /* rơi xuống fetch thường */
    }
  }
  return fetchWithProgress(url, (r) => onProgress?.({ phase: "download", ratio: r }));
}

export async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tải model thất bại: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) {
    return new Uint8Array(await res.arrayBuffer());
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received / total);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function ensureDetector({ modelUrl = DEFAULT_MODEL_URL, onProgress, force = false } = {}) {
  if (session && !force) return session;
  if (sessionPromise && !force) return sessionPromise;
  sessionPromise = (async () => {
    const ort = getOrt();
    if (!modelBytes || force) {
      onProgress?.({ phase: "download", ratio: 0 });
      modelBytes = await fetchCached(modelUrl, (p) => onProgress?.(p));
    }
    onProgress?.({ phase: "init", ratio: 1 });
    session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    onProgress?.({ phase: "ready", ratio: 1 });
    return session;
  })();
  try {
    return await sessionPromise;
  } catch (err) {
    sessionPromise = null;
    throw err;
  }
}

export function clearDetector() {
  if (session?.release) {
    try {
      session.release();
    } catch {
      /* ignore */
    }
  }
  session = null;
  sessionPromise = null;
  modelBytes = null;
}

const INPUT_SIZE = 640;

export async function detect(image, { threshold = 0.4, onProgress } = {}) {
  const ort = getOrt();
  const sess = await ensureDetector({ onProgress });

  const W = image.naturalWidth || image.width;
  const H = image.naturalHeight || image.height;

  const canvas = document.createElement("canvas");
  canvas.width = INPUT_SIZE;
  canvas.height = INPUT_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);

  const n = INPUT_SIZE * INPUT_SIZE;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    input[i] = data[i * 4] / 255;
    input[n + i] = data[i * 4 + 1] / 255;
    input[2 * n + i] = data[i * 4 + 2] / 255;
  }

  const feeds = {
    images: new ort.Tensor("float32", input, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    orig_target_sizes: new ort.Tensor("int64", BigInt64Array.from([BigInt(W), BigInt(H)]), [1, 2]),
  };

  const output = await sess.run(feeds);
  const labels = output.labels.data;
  const scores = output.scores.data;
  const boxes = output.boxes.data;

  const dets = [];
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i];
    if (score < threshold) continue;
    const cls = CLASSES[Number(labels[i])] || "bubble";
    const x1 = boxes[i * 4];
    const y1 = boxes[i * 4 + 1];
    const x2 = boxes[i * 4 + 2];
    const y2 = boxes[i * 4 + 3];
    const x = Math.max(0, Math.min(x1, x2));
    const y = Math.max(0, Math.min(y1, y2));
    const w = Math.min(W, Math.max(x1, x2)) - x;
    const h = Math.min(H, Math.max(y1, y2)) - y;
    if (w < 3 || h < 3) continue;
    dets.push({ cls, score, ...rect(x, y, w, h) });
  }
  dets.sort((a, b) => b.score - a.score);
  return dets;
}
