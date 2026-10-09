import { uid, rect, unionRects, centerInside, containment, area, pad, clamp } from "./util.js";

export const FONT_FAMILIES = [
  { label: "Be Vietnam Pro (khuyến nghị)", value: "'Be Vietnam Pro', 'Noto Sans', sans-serif" },
  { label: "M PLUS Rounded 1c (manga)", value: "'M PLUS Rounded 1c', 'Noto Sans JP', sans-serif" },
  { label: "Baloo 2 (bo tròn)", value: "'Baloo 2', 'Be Vietnam Pro', sans-serif" },
  { label: "Patrick Hand (viết tay)", value: "'Patrick Hand', 'Be Vietnam Pro', sans-serif" },
  { label: "Mali (viết tay)", value: "'Mali', 'Be Vietnam Pro', sans-serif" },
  { label: "Nunito (bo tròn)", value: "'Nunito', 'Be Vietnam Pro', sans-serif" },
  { label: "Quicksand", value: "'Quicksand', 'Be Vietnam Pro', sans-serif" },
  { label: "Noto Sans", value: "'Noto Sans', sans-serif" },
  { label: "Comic Neue (không có tiếng Việt)", value: "'Comic Neue', 'Be Vietnam Pro', sans-serif" },
  { label: "system-ui", value: "system-ui, -apple-system, sans-serif" },
];

export const DEFAULT_FONT = FONT_FAMILIES[0].value;

export function fontFamilyName(value) {
  const first = String(value).split(",")[0].trim();
  return first.replace(/^['"]|['"]$/g, "");
}

export function defaultStyle(size) {
  return {
    family: DEFAULT_FONT,
    size: Math.round(clamp(size || 20, 8, 120)),
    weight: "700",
    italic: false,
    textTransform: "none",
    color: "#111111",
    align: "center",
    valign: "middle",
    lineHeight: 1.2,
    fill: true,
    fillColor: "#ffffff",
    eraseMode: "text",
    eraseInset: 4,
    feather: 0,
    keep: false,
    autoFit: true,
    outline: false,
    outlineColor: "#ffffff",
    outlineWidth: 0,
  };
}

export function makeRegion({ cls = "manual", box, bubble = null, source = "", text = "", style } = {}) {
  return {
    id: uid("r"),
    cls,
    shape: "rect",
    rot: 0,
    quad: null,
    x: Math.round(box.x),
    y: Math.round(box.y),
    w: Math.round(box.w),
    h: Math.round(box.h),
    bubble: bubble
      ? { x: Math.round(bubble.x), y: Math.round(bubble.y), w: Math.round(bubble.w), h: Math.round(bubble.h) }
      : null,
    source,
    text,
    style: style || defaultStyle(box.h),
  };
}

// Góc của 4 đỉnh hình chữ nhật (đã tính xoay) theo thứ tự TL, TR, BR, BL.
export function rectCorners(r) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const a = ((r.rot || 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const hw = r.w / 2;
  const hh = r.h / 2;
  const pt = (dx, dy) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  return [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)];
}

export function regionCenter(r) {
  if (r.shape === "quad" && r.quad) {
    let sx = 0;
    let sy = 0;
    for (const p of r.quad) {
      sx += p[0];
      sy += p[1];
    }
    return { x: sx / r.quad.length, y: sy / r.quad.length };
  }
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function regionAngleDeg(r) {
  // Góc của CHỮ: dùng trường "rot" (không phụ thuộc việc kéo đỉnh đa giác).
  return r.rot || 0;
}

export function regionSize(r) {
  if (r.shape === "quad" && r.quad && r.quad.length >= 2) {
    const c = regionCenter(r);
    const ang = (regionAngleDeg(r) * Math.PI) / 180;
    const cs = Math.cos(-ang);
    const sn = Math.sin(-ang);
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (const p of r.quad) {
      const dx = p[0] - c.x;
      const dy = p[1] - c.y;
      const rx = dx * cs - dy * sn;
      const ry = dx * sn + dy * cs;
      minx = Math.min(minx, rx);
      maxx = Math.max(maxx, rx);
      miny = Math.min(miny, ry);
      maxy = Math.max(maxy, ry);
    }
    return { w: Math.max(8, maxx - minx), h: Math.max(8, maxy - miny) };
  }
  return { w: r.w, h: r.h };
}

// Bao lồi trục (bbox) của vùng, dùng cho cửa sổ inpaint / danh sách.
export function regionBounds(r) {
  const pts = r.shape === "quad" && r.quad ? r.quad : r.rot ? rectCorners(r) : [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Mô tả vùng cần tô/xoá. Trả về {kind:'rect',...} | {kind:'poly', pts} | null.
// - "text": tô đúng ô chữ (nới 2px) -> giữ viền bong bóng. - "bubble": tô bbox bong bóng thu vào eraseInset.
export function eraseShape(r) {
  const st = r.style || {};
  if (st.keep) return null;
  if (st.eraseMode === "none" || st.fill === false) return null;
  const ins = st.eraseInset || 0;
  if (r.shape === "quad" && r.quad) {
    return { kind: "poly", pts: r.quad.map((p) => [p[0], p[1]]) };
  }
  if (r.rot) {
    let cx = r.x + r.w / 2;
    let cy = r.y + r.h / 2;
    let w = r.w + 4;
    let h = r.h + 4;
    if (st.eraseMode === "bubble" && r.bubble) {
      cx = r.bubble.x + r.bubble.w / 2;
      cy = r.bubble.y + r.bubble.h / 2;
      w = Math.max(1, r.bubble.w - 2 * ins);
      h = Math.max(1, r.bubble.h - 2 * ins);
    }
    return { kind: "rect", cx, cy, w, h, rot: r.rot };
  }
  if (st.eraseMode === "bubble" && r.bubble) {
    const b = r.bubble;
    return { kind: "rect", x: b.x + ins, y: b.y + ins, w: Math.max(1, b.w - 2 * ins), h: Math.max(1, b.h - 2 * ins), rot: 0 };
  }
  const pad = 2;
  return { kind: "rect", x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad, rot: 0 };
}

// Vẽ đường bao của một descriptor lên ctx (dùng cho fill hoặc clip).
export function pathShape(ctx, s) {
  ctx.beginPath();
  if (s.kind === "poly") {
    s.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
  } else if (s.rot) {
    ctx.save();
    ctx.translate(s.cx, s.cy);
    ctx.rotate((s.rot * Math.PI) / 180);
    ctx.rect(-s.w / 2, -s.h / 2, s.w, s.h);
    ctx.restore();
  } else {
    ctx.rect(s.x, s.y, s.w, s.h);
  }
}

export function buildRegions(dets) {
  const bubbles = dets.filter((d) => d.cls === "bubble").sort((a, b) => area(a) - area(b));
  const texts = dets.filter((d) => d.cls === "text_bubble" || d.cls === "text_free");
  const used = new Set();
  const regions = [];

  for (const bubble of bubbles) {
    const inside = texts.filter((t) => !used.has(t) && (centerInside(t, bubble) || containment(t, bubble) > 0.6));
    if (!inside.length) continue;
    inside.forEach((t) => used.add(t));
    const textBox = pad(unionRects(inside), 3);
    const region = makeRegion({ cls: "text_bubble", box: textBox, bubble });
    region.style.eraseMode = "text";
    regions.push(region);
  }

  for (const t of texts) {
    if (used.has(t)) continue;
    const region = makeRegion({ cls: t.cls, box: rect(t.x, t.y, t.w, t.h) });
    region.style.eraseMode = "text";
    regions.push(region);
  }

  regions.sort((a, b) => a.y - b.y || a.x - b.x);
  return regions;
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function tokenize(text) {
  const tokens = [];
  const parts = text.split(/(\s+)/);
  for (const part of parts) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      tokens.push(" ");
      continue;
    }
    let buf = "";
    for (const ch of part) {
      if (CJK.test(ch)) {
        if (buf) {
          tokens.push(buf);
          buf = "";
        }
        tokens.push(ch);
      } else {
        buf += ch;
      }
    }
    if (buf) tokens.push(buf);
  }
  return tokens;
}

export function fontString(style, size) {
  return `${style.italic ? "italic " : ""}${style.weight} ${size}px ${style.family}`;
}

export function applyTransform(text, transform) {
  const t = text || "";
  if (transform === "uppercase") return t.toUpperCase();
  if (transform === "lowercase") return t.toLowerCase();
  if (transform === "capitalize") return t.replace(/(^|\s)(\S)/g, (m, sp, ch) => sp + ch.toUpperCase());
  return t;
}

export function wrapText(ctx, tokens, maxWidth) {
  const lines = [];
  let line = "";
  const push = () => {
    lines.push(line);
    line = "";
  };
  for (const tok of tokens) {
    if (tok === " ") {
      if (line) line += " ";
      continue;
    }
    const candidate = line ? line + tok : tok;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      if (ctx.measureText(candidate).width > maxWidth && !line) {
        // break a single oversized token by characters
        let chunk = "";
        for (const ch of tok) {
          if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      } else {
        line = candidate;
      }
    } else {
      push();
      line = tok;
    }
  }
  push();
  return lines.length ? lines : [""];
}

export function fitText(ctx, text, boxW, boxH, style) {
  const safeW = Math.max(8, boxW - 4);
  const tokens = tokenize(applyTransform(text || "", style.textTransform));
  const min = 7;

  if (!style.autoFit) {
    const size = Math.round(clamp(style.size, min, 200));
    ctx.font = fontString(style, size);
    const lines = wrapText(ctx, tokens, safeW);
    const lh = size * style.lineHeight;
    return { size, lines, lh, total: lines.length * lh };
  }

  const cap = Math.round(clamp(boxH, 8, 160));
  for (let size = cap; size >= min; size--) {
    ctx.font = fontString(style, size);
    const lines = wrapText(ctx, tokens, safeW);
    const lh = size * style.lineHeight;
    const total = lines.length * lh;
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if (total <= boxH + 1 && widest <= safeW + 0.5) return { size, lines, lh, total };
  }
  ctx.font = fontString(style, min);
  const lines = wrapText(ctx, tokens, safeW);
  return { size: min, lines, lh: min * style.lineHeight, total: lines.length * min * style.lineHeight, overflow: true };
}
