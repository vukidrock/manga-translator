import { fitText, fontString, eraseShape, pathShape, regionSize, regionCenter, regionAngleDeg, regionBounds } from "./regions.js";

let measureCtx = null;
function getMeasureCtx() {
  if (!measureCtx) {
    const c = document.createElement("canvas");
    c.width = 8;
    c.height = 8;
    measureCtx = c.getContext("2d");
  }
  return measureCtx;
}

export function computeLayout(region) {
  const ctx = getMeasureCtx();
  const { w, h } = regionSize(region);
  return fitText(ctx, region.text || "", w, h, region.style);
}

function drawMasks(ctx, regions) {
  for (const r of regions) {
    const s = eraseShape(r);
    if (!s) continue;
    const feather = r.style.feather || 0;
    if (feather > 0) ctx.filter = `blur(${feather}px)`;
    ctx.fillStyle = r.style.fillColor || "#ffffff";
    if (s.kind === "poly") {
      pathShape(ctx, s);
      ctx.fill();
    } else if (s.rot) {
      ctx.save();
      ctx.translate(s.cx, s.cy);
      ctx.rotate((s.rot * Math.PI) / 180);
      ctx.fillRect(-s.w / 2, -s.h / 2, s.w, s.h);
      ctx.restore();
    } else {
      ctx.fillRect(s.x, s.y, s.w, s.h);
    }
    if (feather > 0) ctx.filter = "none";
  }
}

function drawRegionText(ctx, region, layout) {
  if (!region.text || region.style.keep) return;
  const { size, lines, lh } = layout;
  const style = region.style;
  const { w, h } = regionSize(region);
  const c = regionCenter(region);
  const ang = (regionAngleDeg(region) * Math.PI) / 180;

  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(ang);
  ctx.font = fontString(style, size);
  ctx.textBaseline = "middle";
  ctx.textAlign = style.align === "left" ? "left" : style.align === "right" ? "right" : "center";

  const total = lines.length * lh;
  let y0;
  if (style.valign === "top") y0 = -h / 2 + lh / 2;
  else if (style.valign === "bottom") y0 = h / 2 - total + lh / 2;
  else y0 = (h - total) / 2 - h / 2 + lh / 2;
  const x = style.align === "left" ? -w / 2 + 2 : style.align === "right" ? w / 2 - 2 : 0;

  for (let i = 0; i < lines.length; i++) {
    const y = y0 + i * lh;
    if (style.outline && style.outlineWidth > 0) {
      ctx.lineWidth = style.outlineWidth;
      ctx.strokeStyle = style.outlineColor || "#ffffff";
      ctx.lineJoin = "round";
      ctx.strokeText(lines[i], x, y);
    }
    ctx.fillStyle = style.color || "#111111";
    ctx.fillText(lines[i], x, y);
  }
  ctx.restore();
}

function restoreKept(ctx, r, originalImage) {
  const b = regionBounds(r);
  ctx.save();
  const s = eraseShape({ ...r, style: { ...r.style, keep: false, eraseMode: "text" } });
  if (s) {
    pathShape(ctx, s);
    ctx.clip();
  } else {
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();
  }
  ctx.drawImage(originalImage, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
  ctx.restore();
}

export function renderPage(image, regions, { skipErase = false, originalImage = null } = {}) {
  const W = image.naturalWidth || image.width;
  const H = image.naturalHeight || image.height;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, W, H);

  // Nếu nền đã xoá chữ (inpaint): khôi phục lại vùng "giữ nguyên" từ ảnh gốc.
  if (skipErase && originalImage) {
    for (const r of regions) {
      if (!r.style?.keep) continue;
      restoreKept(ctx, r, originalImage);
    }
  }

  if (!skipErase) drawMasks(ctx, regions);
  const layouts = regions.map((r) => ({ r, layout: computeLayout(r) }));
  for (const { r, layout } of layouts) drawRegionText(ctx, r, layout);
  return canvas;
}

export async function exportPageBlob(image, regions, { type = "image/png", quality, skipErase = false, originalImage = null } = {}) {
  const canvas = renderPage(image, regions, { skipErase, originalImage });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export function makeThumb(image, maxWidth = 120) {
  const W = image.naturalWidth || image.width;
  const H = image.naturalHeight || image.height;
  const scale = Math.min(1, maxWidth / W);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(W * scale));
  canvas.height = Math.max(1, Math.round(H * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
