import { getOrt, fetchCached } from "./detector.js";
import { pathShape, rectCorners } from "./regions.js";

const MODEL_URL =
  "https://huggingface.co/Liiesl/lama-manga-onnx-quant/resolve/main/lama-manga_int8.onnx";
const SIZE = 512;
const CONTEXT_PAD = 48;

let session = null;
let bytes = null;
let sessionPromise = null;

export async function ensureInpaintModel({ onProgress, force = false } = {}) {
  if (session && !force) return session;
  if (sessionPromise && !force) return sessionPromise;
  sessionPromise = (async () => {
    const ort = getOrt();
    if (!bytes || force) {
      bytes = await fetchCached(MODEL_URL, onProgress);
    }
    onProgress?.({ phase: "init", ratio: 1 });
    session = await createSession(ort, bytes);
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

async function createSession(ort, modelBytes) {
  return ort.InferenceSession.create(modelBytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
}

export function clearInpaintModel() {
  if (session?.release) {
    try {
      session.release();
    } catch {
      /* ignore */
    }
  }
  session = null;
  sessionPromise = null;
  bytes = null;
}

function newCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function clampRect(r, W, H) {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  return { x, y, w: Math.min(W - x, Math.ceil(r.w)), h: Math.min(H - y, Math.ceil(r.h)) };
}

// Vùng cần xoá để inpaint: dùng theo hình của vùng (rect/xoay/tứ giác), luôn xoá chữ gốc.
function shapeFor(r) {
  if (r.shape === "quad" && r.quad) return { kind: "poly", pts: r.quad.map((p) => [p[0], p[1]]) };
  if (r.rot) return { kind: "rect", cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w + 6, h: r.h + 6, rot: r.rot };
  return { kind: "rect", x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6, rot: 0 };
}
function shapeBounds(s) {
  const pts = s.kind === "poly" ? s.pts : rectCorners({ x: 0, y: 0, w: 0, h: 0, ...rectAsRect(s) });
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function rectAsRect(s) {
  if (!s.rot) return { x: s.x, y: s.y, w: s.w, h: s.h };
  return { x: s.cx - s.w / 2, y: s.cy - s.h / 2, w: s.w, h: s.h, rot: s.rot };
}

function expand(r, p) {
  return { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p };
}

// Đưa cửa sổ (win) vào ảnh vuông SxS, phần trống lấp bằng lặp viền (edge replicate).
function squareFromImage(src, win, S, ox, oy) {
  const c = newCanvas(S, S);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, win.x, win.y, win.w, win.h, ox, oy, win.w, win.h);
  const sr = S - (ox + win.w);
  const sb = S - (oy + win.h);
  if (ox > 0) ctx.drawImage(src, win.x, win.y, 1, win.h, 0, oy, ox, win.h);
  if (sr > 0) ctx.drawImage(src, win.x + win.w - 1, win.y, 1, win.h, ox + win.w, oy, sr, win.h);
  if (oy > 0) ctx.drawImage(src, win.x, win.y, win.w, 1, ox, 0, win.w, oy);
  if (sb > 0) ctx.drawImage(src, win.x, win.y + win.h - 1, win.w, 1, ox, oy + win.h, win.w, sb);
  if (ox > 0 && oy > 0) ctx.drawImage(src, win.x, win.y, 1, 1, 0, 0, ox, oy);
  if (sr > 0 && oy > 0) ctx.drawImage(src, win.x + win.w - 1, win.y, 1, 1, ox + win.w, 0, sr, oy);
  if (ox > 0 && sb > 0) ctx.drawImage(src, win.x, win.y + win.h - 1, 1, 1, 0, oy + win.h, ox, sb);
  if (sr > 0 && sb > 0)
    ctx.drawImage(src, win.x + win.w - 1, win.y + win.h - 1, 1, 1, ox + win.w, oy + win.h, sr, sb);
  return c;
}

function squareMask(shape, win, S, ox, oy) {
  const c = newCanvas(S, S);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, S, S);
  ctx.save();
  ctx.translate(ox - win.x, oy - win.y);
  ctx.fillStyle = "#fff";
  pathShape(ctx, shape);
  ctx.fill();
  ctx.restore();
  return c;
}

function resizeCanvas(src, size, smooth) {
  const c = newCanvas(size, size);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, size, size);
  return c;
}

/**
 * Xoá chữ bằng LaMa manga int8 (input 512 cố định), theo từng cửa sổ quanh mỗi vùng.
 * Trả về canvas ảnh đã làm sạch, giữ nguyên kích thước gốc.
 */
export async function inpaintImage(image, regions, { onProgress, contextPad = CONTEXT_PAD } = {}) {
  const ort = getOrt();
  const sess = await ensureInpaintModel({ onProgress });
  const inName = sess.inputNames[0];
  const outName = sess.outputNames[0];

  const W = image.naturalWidth || image.width;
  const H = image.naturalHeight || image.height;

  const output = newCanvas(W, H);
  const octx = output.getContext("2d");
  octx.drawImage(image, 0, 0);

  const targets = [];
  for (const r of regions) {
    if (r.style?.keep) continue;
    const shape = shapeFor(r);
    const bb = shapeBounds(shape);
    if (bb.w < 3 || bb.h < 3) continue;
    targets.push({ shape, bb });
  }

  for (let i = 0; i < targets.length; i++) {
    const { shape, bb } = targets[i];
    const win = clampRect(expand(bb, contextPad), W, H);
    const S = Math.max(64, Math.max(win.w, win.h));
    const ox = Math.floor((S - win.w) / 2);
    const oy = Math.floor((S - win.h) / 2);

    const sqImg = squareFromImage(image, win, S, ox, oy);
    const sqMask = squareMask(shape, win, S, ox, oy);

    const img512 = resizeCanvas(sqImg, SIZE, true);
    const mask512 = resizeCanvas(sqMask, SIZE, false);
    const id = img512.getContext("2d").getImageData(0, 0, SIZE, SIZE).data;
    const md = mask512.getContext("2d").getImageData(0, 0, SIZE, SIZE).data;

    const n = SIZE * SIZE;
    const input = new Float32Array(4 * n);
    for (let p = 0; p < n; p++) {
      const mk = md[p * 4] > 127 ? 1 : 0;
      const inv = 1 - mk;
      input[p] = (id[p * 4] / 255) * inv;
      input[n + p] = (id[p * 4 + 1] / 255) * inv;
      input[2 * n + p] = (id[p * 4 + 2] / 255) * inv;
      input[3 * n + p] = mk;
    }

    const tensor = new ort.Tensor("float32", input, [1, 4, SIZE, SIZE]);
    const out = await sess.run({ [inName]: tensor });
    const res = out[outName].data; // 3*SIZE*SIZE

    const outCanvas = newCanvas(SIZE, SIZE);
    const octx2 = outCanvas.getContext("2d");
    const oimg = octx2.createImageData(SIZE, SIZE);
    for (let p = 0; p < n; p++) {
      oimg.data[p * 4] = Math.max(0, Math.min(255, res[p] * 255));
      oimg.data[p * 4 + 1] = Math.max(0, Math.min(255, res[n + p] * 255));
      oimg.data[p * 4 + 2] = Math.max(0, Math.min(255, res[2 * n + p] * 255));
      oimg.data[p * 4 + 3] = 255;
    }
    octx2.putImageData(oimg, 0, 0);

    // 512 -> S -> cắt đúng cửa sổ
    const sqOut = newCanvas(S, S);
    sqOut.getContext("2d").drawImage(outCanvas, 0, 0, S, S);
    const winRes = newCanvas(win.w, win.h);
    winRes
      .getContext("2d")
      .drawImage(sqOut, ox, oy, win.w, win.h, 0, 0, win.w, win.h);

    // Viền mềm rồi ghép vào ảnh
    const feath = newCanvas(win.w, win.h);
    const fctx = feath.getContext("2d");
    fctx.filter = "blur(4px)";
    fctx.fillStyle = "#fff";
    fctx.save();
    fctx.translate(-win.x, -win.y);
    pathShape(fctx, shape);
    fctx.fill();
    fctx.restore();
    fctx.filter = "none";

    const wctx = winRes.getContext("2d");
    wctx.globalCompositeOperation = "destination-in";
    wctx.drawImage(feath, 0, 0);
    wctx.globalCompositeOperation = "source-over";

    octx.drawImage(winRes, win.x, win.y);
    onProgress?.({ phase: "inpaint", ratio: (i + 1) / targets.length });
  }

  onProgress?.({ phase: "done", ratio: 1 });
  return output;
}

// Inpaint theo mask raster (cọ tẩy): xoá đúng vùng đã tô.
export async function inpaintRaster(image, maskCanvas, { onProgress, contextPad = CONTEXT_PAD } = {}) {
  const ort = getOrt();
  const sess = await ensureInpaintModel({ onProgress });
  const inName = sess.inputNames[0];
  const outName = sess.outputNames[0];
  const W = image.naturalWidth || image.width;
  const H = image.naturalHeight || image.height;

  const md = maskCanvas.getContext("2d").getImageData(0, 0, W, H).data;
  let minx = W;
  let miny = H;
  let maxx = -1;
  let maxy = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (md[(y * W + x) * 4] > 127) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
  }
  if (maxx < 0) return null;
  const bb = { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 };
  const win = clampRect(expand(bb, contextPad), W, H);
  const S = Math.max(64, Math.max(win.w, win.h));
  const ox = Math.floor((S - win.w) / 2);
  const oy = Math.floor((S - win.h) / 2);

  const sqImg = squareFromImage(image, win, S, ox, oy);
  const sqMask = newCanvas(S, S);
  const mctx = sqMask.getContext("2d");
  mctx.fillStyle = "#000";
  mctx.fillRect(0, 0, S, S);
  mctx.drawImage(maskCanvas, win.x, win.y, win.w, win.h, ox, oy, win.w, win.h);

  const img512 = resizeCanvas(sqImg, SIZE, true);
  const mask512 = resizeCanvas(sqMask, SIZE, false);
  const id = img512.getContext("2d").getImageData(0, 0, SIZE, SIZE).data;
  const mdd = mask512.getContext("2d").getImageData(0, 0, SIZE, SIZE).data;
  const n = SIZE * SIZE;
  const input = new Float32Array(4 * n);
  for (let p = 0; p < n; p++) {
    const mk = mdd[p * 4] > 127 ? 1 : 0;
    const inv = 1 - mk;
    input[p] = (id[p * 4] / 255) * inv;
    input[n + p] = (id[p * 4 + 1] / 255) * inv;
    input[2 * n + p] = (id[p * 4 + 2] / 255) * inv;
    input[3 * n + p] = mk;
  }
  onProgress?.({ phase: "inpaint", ratio: 0.3 });
  const out = await sess.run({ [inName]: new ort.Tensor("float32", input, [1, 4, SIZE, SIZE]) });
  const res = out[outName].data;

  const outCanvas = newCanvas(SIZE, SIZE);
  const octx2 = outCanvas.getContext("2d");
  const oimg = octx2.createImageData(SIZE, SIZE);
  for (let p = 0; p < n; p++) {
    oimg.data[p * 4] = Math.max(0, Math.min(255, res[p] * 255));
    oimg.data[p * 4 + 1] = Math.max(0, Math.min(255, res[n + p] * 255));
    oimg.data[p * 4 + 2] = Math.max(0, Math.min(255, res[2 * n + p] * 255));
    oimg.data[p * 4 + 3] = 255;
  }
  octx2.putImageData(oimg, 0, 0);

  const sqOut = newCanvas(S, S);
  sqOut.getContext("2d").drawImage(outCanvas, 0, 0, S, S);
  const winRes = newCanvas(win.w, win.h);
  winRes.getContext("2d").drawImage(sqOut, ox, oy, win.w, win.h, 0, 0, win.w, win.h);

  const feath = newCanvas(win.w, win.h);
  const fctx = feath.getContext("2d");
  fctx.filter = "blur(4px)";
  fctx.drawImage(maskCanvas, win.x, win.y, win.w, win.h, 0, 0, win.w, win.h);
  fctx.filter = "none";
  const wctx = winRes.getContext("2d");
  wctx.globalCompositeOperation = "destination-in";
  wctx.drawImage(feath, 0, 0);
  wctx.globalCompositeOperation = "source-over";

  const output = newCanvas(W, H);
  const octx = output.getContext("2d");
  octx.drawImage(image, 0, 0);
  octx.drawImage(winRes, win.x, win.y);
  onProgress?.({ phase: "done", ratio: 1 });
  return output;
}
