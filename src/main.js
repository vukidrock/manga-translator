import {
  clamp,
  loadImage,
  download,
  canvasToBlob,
  debounce,
  escapeHtml,
  containsPoint,
  center,
  nextFrame,
} from "./util.js";
import { detect, CLASS_LABEL_VI } from "./detector.js";
import { recognize, ocrCanvas } from "./ocr.js";
import { DIRECTIONS, translateBatch } from "./translate.js";
import { geminiTranslatePage, listGeminiModels } from "./gemini.js";
import { APP_VERSION } from "./version.js";
import {
  buildRegions,
  makeRegion,
  FONT_FAMILIES,
  eraseShape,
  fontFamilyName,
  defaultStyle,
  regionSize,
  regionCenter,
  regionAngleDeg,
  regionBounds,
  rectCorners,
} from "./regions.js";
import { renderPage, exportPageBlob, makeThumb, computeLayout } from "./render.js";
import { inpaintImage } from "./inpaint.js";
import {
  createState,
  persist,
  restore,
  createPageFromBlob,
  exportProject,
  importProject,
} from "./project.js";

const $ = (id) => document.getElementById(id);
const els = {
  projectName: $("projectName"),
  appVersion: $("appVersion"),
  menuVersion: $("menuVersion"),
  pageImg: $("pageImg"),
  stage: $("stage"),
  stageScroll: $("stageScroll"),
  overlay: $("overlay"),
  pagesList: $("pagesList"),
  regionList: $("regionList"),
  fields: $("fields"),
  globalFields: $("globalFields"),
  emptyHint: $("emptyHint"),
  status: $("status"),
  pageInfo: $("pageInfo"),
  threshold: $("threshold"),
  thresholdVal: $("thresholdVal"),
  ocrModeRegion: $("ocrModeRegion"),
  ocrLang: $("ocrLang"),
  btnTranslate: $("btnTranslate"),
  transDir: $("transDir"),
  transProvider: $("transProvider"),
  geminiKey: $("geminiKey"),
  geminiModel: $("geminiModel"),
  geminiKeyRow: $("geminiKeyRow"),
  geminiModelRow: $("geminiModelRow"),
  geminiUsage: $("geminiUsage"),
  geminiCountdown: $("geminiCountdown"),
  geminiLimits: $("geminiLimits"),
  limRpm: $("limRpm"),
  limTpm: $("limTpm"),
  limRpd: $("limRpd"),
  fileInput: $("fileInput"),
  projectInput: $("projectInput"),
  dropzone: $("dropzone"),
  zoomLabel: $("zoomLabel"),
  showBoxes: $("showBoxes"),
  compareToggle: $("compareToggle"),
  panes: $("panes"),
  paneResult: $("paneResult"),
  resultScroll: $("resultScroll"),
  resultStage: $("resultStage"),
  resultCanvas: $("resultCanvas"),
  btnTheme: $("btnTheme"),
  btnMenu: $("btnMenu"),
  topMenu: $("topMenu"),
  btnAddUrl: $("btnAddUrl"),
  urlModal: $("urlModal"),
  urlInput: $("urlInput"),
  urlProxy: $("urlProxy"),
  urlJina: $("urlJina"),
  urlJinaKey: $("urlJinaKey"),
  urlStatus: $("urlStatus"),
  urlFetch: $("urlFetch"),
  urlExtract: $("urlExtract"),
  urlCancel: $("urlCancel"),
};

function applyTheme(mode) {
  const next = mode === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("mt-theme", next);
  } catch {
    /* ignore */
  }
  if (els.btnTheme) {
    els.btnTheme.textContent = next === "dark" ? "Nền sáng" : "Nền tối";
    els.btnTheme.title = next === "dark" ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối";
  }
}

let state = createState();
let selectedId = null;
let drawMode = false;
let busy = false;
let bootDone;
const bootReady = new Promise((r) => (bootDone = r));

const imageCache = new Map();
function getPageImage(page) {
  if (imageCache.has(page.id)) return imageCache.get(page.id);
  const url = URL.createObjectURL(page.imageBlob);
  const promise = loadImage(url).then((img) => ({ img, url }));
  imageCache.set(page.id, promise);
  return promise;
}
function dropPageImage(pageId) {
  const entry = imageCache.get(pageId);
  if (entry) {
    entry.then(({ url }) => URL.revokeObjectURL(url)).catch(() => {});
    imageCache.delete(pageId);
  }
}

const cleanCache = new Map();
function getCleanImage(page) {
  if (!page.cleanBlob) return null;
  if (cleanCache.has(page.id)) return cleanCache.get(page.id);
  const url = URL.createObjectURL(page.cleanBlob);
  const promise = loadImage(url).then((img) => ({ img, url }));
  cleanCache.set(page.id, promise);
  return promise;
}
function dropCleanImage(pageId) {
  const entry = cleanCache.get(pageId);
  if (entry) {
    entry.then(({ url }) => URL.revokeObjectURL(url)).catch(() => {});
    cleanCache.delete(pageId);
  }
}
async function workingImage(page) {
  if (page.cleanBlob) {
    const clean = await getCleanImage(page);
    return clean.img;
  }
  const { img } = await getPageImage(page);
  return img;
}

const activePage = () => state.pages.find((p) => p.id === state.activeId) || null;
const activeRegion = () => activePage()?.regions.find((r) => r.id === selectedId) || null;

// Các thuộc tính "kiểu chữ" áp dụng chung; vùng có custom=true thì giữ riêng.
function updateTransProviderUI() {
  const gem = (state.settings.transProvider || "offline") === "gemini";
  const cooling = geminiCooldownUntil > Date.now();
  if (els.geminiKeyRow) els.geminiKeyRow.style.display = gem ? "" : "none";
  if (els.geminiModelRow) els.geminiModelRow.style.display = gem ? "" : "none";
  if (els.geminiUsage) els.geminiUsage.style.display = gem ? "" : "none";
  if (els.geminiLimits) els.geminiLimits.style.display = gem ? "" : "none";
  if (els.geminiCountdown) els.geminiCountdown.style.display = gem && cooling ? "" : "none";
  if (els.btnTranslate) els.btnTranslate.disabled = busy || cooling;
  updateGeminiUsageUI();
}

function initGeminiLimitsUI() {
  const L = { rpm: 5, tpm: 250000, rpd: 20, ...(state.settings.geminiLimits || {}) };
  if (els.limRpm) els.limRpm.value = L.rpm;
  if (els.limTpm) els.limTpm.value = L.tpm;
  if (els.limRpd) els.limRpd.value = L.rpd;
}

function initTransUI() {
  els.transProvider.value = state.settings.transProvider || "offline";
  els.geminiModel.value = state.settings.geminiModel || els.geminiModel.value;
  try {
    els.geminiKey.value = localStorage.getItem("mt-gemini-key") || "";
  } catch {
    /* ignore */
  }
  updateTransProviderUI();
  initGeminiLimitsUI();
  updateGeminiUsageUI();
  if (els.geminiKey.value) refreshGeminiModels();
}

function parseDuration(str) {
  const m = /(?:([\d.]+)h)?(?:([\d.]+)m)?(?:([\d.]+)s)?/.exec(str || "");
  if (!m) return 0;
  const h = parseFloat(m[1] || "0");
  const mi = parseFloat(m[2] || "0");
  const s = parseFloat(m[3] || "0");
  return Math.round(((h * 60 + mi) * 60 + s) * 1000);
}

const GEMINI_USAGE_KEY = "mt-gemini-usage";
const todayKey = () => new Date().toISOString().slice(0, 10);
function loadGeminiUsage() {
  try {
    const u = JSON.parse(localStorage.getItem(GEMINI_USAGE_KEY) || "null");
    if (u && u.date === todayKey() && Array.isArray(u.events)) return u;
  } catch {
    /* ignore */
  }
  return { date: todayKey(), events: [] };
}
function saveGeminiUsage(u) {
  try {
    localStorage.setItem(GEMINI_USAGE_KEY, JSON.stringify(u));
  } catch {
    /* ignore */
  }
}
function addGeminiUsage(usage) {
  const u = loadGeminiUsage();
  u.events.push({ t: Date.now(), pt: usage?.promptTokenCount || 0, ot: usage?.candidatesTokenCount || 0 });
  saveGeminiUsage(u);
  updateGeminiUsageUI();
}
function geminiStats() {
  const u = loadGeminiUsage();
  const now = Date.now();
  const last60 = u.events.filter((e) => now - e.t < 60000);
  return {
    rpm: last60.length,
    tpm: last60.reduce((a, e) => a + e.pt + e.ot, 0),
    rpd: u.events.length,
  };
}
const fmtCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K` : String(n));
function updateGeminiUsageUI() {
  if (!els.geminiUsage) return;
  const s = geminiStats();
  const L = { rpm: 5, tpm: 250000, rpd: 20, ...(state.settings.geminiLimits || {}) };
  const over = s.rpm >= L.rpm || s.tpm >= L.tpm || s.rpd >= L.rpd;
  const near = s.rpm >= L.rpm * 0.8 || s.tpm >= L.tpm * 0.8 || s.rpd >= L.rpd * 0.8;
  els.geminiUsage.style.color = over ? "var(--danger)" : near ? "#d97706" : "";
  els.geminiUsage.textContent = `Đã dùng: RPD ${s.rpd}/${L.rpd} · RPM ${s.rpm}/${L.rpm} · TPM ${fmtCount(s.tpm)}/${fmtCount(L.tpm)}`;
}

const GEMINI_COOLDOWN_KEY = "mt-gemini-cooldown";
let geminiCooldownUntil = 0;
let geminiCooldownTimer = null;
function startGeminiCooldown(ms) {
  if (!ms || ms <= 0) return;
  geminiCooldownUntil = Date.now() + ms;
  try {
    localStorage.setItem(GEMINI_COOLDOWN_KEY, String(geminiCooldownUntil));
  } catch {
    /* ignore */
  }
  clearInterval(geminiCooldownTimer);
  const tick = () => {
    const left = geminiCooldownUntil - Date.now();
    if (left <= 0) {
      clearInterval(geminiCooldownTimer);
      geminiCooldownTimer = null;
      geminiCooldownUntil = 0;
      try {
        localStorage.removeItem(GEMINI_COOLDOWN_KEY);
      } catch {
        /* ignore */
      }
      if (els.geminiCountdown) els.geminiCountdown.style.display = "none";
      els.btnTranslate.disabled = busy;
      setStatus("Gemini đã hết thời gian chờ, có thể dịch lại.", false, true);
      return;
    }
    const s = Math.ceil(left / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const txt = `${hh ? hh + "h" : ""}${mm ? mm + "m" : ""}${ss}s`;
    if (els.geminiCountdown) {
      els.geminiCountdown.style.display = "";
      els.geminiCountdown.textContent = `Gemini bị giới hạn — thử lại sau ${txt}`;
    }
    els.btnTranslate.disabled = true;
  };
  tick();
  geminiCooldownTimer = setInterval(tick, 1000);
}
function restoreGeminiCooldown() {
  try {
    const until = Number(localStorage.getItem(GEMINI_COOLDOWN_KEY) || 0);
    if (until > Date.now()) startGeminiCooldown(until - Date.now());
  } catch {
    /* ignore */
  }
}

// Ưu tiên model có free tier (tránh bản premium/omni bị limit 0). Flash-Lite free RPD cao.
const GEMINI_FREE_PREFERENCE = [
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-flash-latest",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
];
// Gợi ý hạn mức free tier theo model (có thể chỉnh tay trong menu).
function suggestLimitsForModel(id = "") {
  if (/flash-lite|lite/i.test(id)) return { rpm: 15, tpm: 250000, rpd: 500 };
  if (/flash/i.test(id)) return { rpm: 5, tpm: 250000, rpd: 20 };
  return null;
}
function pickDefaultGeminiModel(models) {
  for (const id of GEMINI_FREE_PREFERENCE) {
    if (models.some((m) => m.id === id)) return id;
  }
  const flash = models.filter((m) => /flash/i.test(m.id) && !/(pro|omni|ultra|8b)/i.test(m.id));
  return flash[0]?.id || models[0]?.id || "";
}
function applySuggestedLimits(modelId) {
  const lim = suggestLimitsForModel(modelId);
  if (!lim) return;
  state.settings.geminiLimits = lim;
  if (els.limRpm) els.limRpm.value = lim.rpm;
  if (els.limTpm) els.limTpm.value = lim.tpm;
  if (els.limRpd) els.limRpd.value = lim.rpd;
  updateGeminiUsageUI();
}

let geminiModelsLoaded = false;
async function refreshGeminiModels() {
  const key = (els.geminiKey.value || "").trim();
  if (!key) return;
  try {
    const models = await listGeminiModels(key);
    if (!models.length) return;
    const keep = state.settings.geminiModel;
    els.geminiModel.innerHTML = models
      .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)} (${escapeHtml(m.id)})</option>`)
      .join("");
    const chosen = models.some((m) => m.id === keep) ? keep : pickDefaultGeminiModel(models);
    els.geminiModel.value = chosen;
    state.settings.geminiModel = chosen;
    if (chosen !== keep) applySuggestedLimits(chosen);
    geminiModelsLoaded = true;
    persistSoon();
  } catch (err) {
    setStatus(`Không lấy được danh sách model Gemini: ${err.message}`);
  }
}

const GLOBAL_KEYS = ["family", "weight", "italic", "textTransform", "color", "align", "valign", "autoFit", "lineHeight"];
const globalTextStyle = () => state.settings.style;

function applyGlobalToRegion(r) {
  r.custom = false;
  for (const k of GLOBAL_KEYS) r.style[k] = state.settings.style[k];
}

function updateGlobalStyle(key, value) {
  state.settings.style[key] = value;
  for (const page of state.pages) {
    for (const r of page.regions) {
      if (!r.custom) r.style[key] = value;
    }
  }
  renderOverlay();
  renderRegionsList();
  renderFields();
  persistSoon();
}

function renderGlobalFields() {
  const g = globalTextStyle();
  const fontOptions = FONT_FAMILIES.map(
    (f) => `<option value="${escapeHtml(f.value)}" ${f.value === g.family ? "selected" : ""}>${f.label}</option>`,
  ).join("");
  els.globalFields.innerHTML = `
    <div>
      <label>Kiểu chữ</label>
      <select id="gFamily">${fontOptions}</select>
    </div>
    <div class="grid3">
      <div><label>Cỡ (khi không tự co)</label><input type="number" id="gSize" min="7" max="160" value="${g.size}"/></div>
      <div><label>Kiểu</label><select id="gWeight"><option value="400" ${g.weight === "400" ? "selected" : ""}>Thường</option><option value="700" ${g.weight === "700" ? "selected" : ""}>Đậm</option></select></div>
      <div><label>Màu</label><input type="color" id="gColor" value="${g.color}"/></div>
    </div>
    <div class="row">
      <div><label>Dạng chữ</label><select id="gTransform">
        <option value="none" ${g.textTransform === "none" ? "selected" : ""}>Bình thường</option>
        <option value="uppercase" ${g.textTransform === "uppercase" ? "selected" : ""}>IN HOA</option>
        <option value="lowercase" ${g.textTransform === "lowercase" ? "selected" : ""}>in thường</option>
        <option value="capitalize" ${g.textTransform === "capitalize" ? "selected" : ""}>Viết Hoa</option>
      </select></div>
      <label class="inline" style="text-transform:none;color:var(--text);align-self:flex-end;padding-bottom:7px"><input type="checkbox" id="gItalic" ${g.italic ? "checked" : ""}/> In nghiêng</label>
    </div>
    <div class="row">
      <div><label>Ngang</label><select id="gAlign">
        <option value="left" ${g.align === "left" ? "selected" : ""}>Trái</option>
        <option value="center" ${g.align === "center" ? "selected" : ""}>Giữa</option>
        <option value="right" ${g.align === "right" ? "selected" : ""}>Phải</option>
      </select></div>
      <div><label>Dọc</label><select id="gValign">
        <option value="top" ${g.valign === "top" ? "selected" : ""}>Trên</option>
        <option value="middle" ${g.valign === "middle" ? "selected" : ""}>Giữa</option>
        <option value="bottom" ${g.valign === "bottom" ? "selected" : ""}>Dưới</option>
      </select></div>
    </div>
    <label class="inline" style="text-transform:none;color:var(--text)"><input type="checkbox" id="gAutoFit" ${g.autoFit ? "checked" : ""}/> Tự co chữ cho vừa</label>`;

  const on = (id, ev, fn) => els.globalFields.querySelector(id)?.addEventListener(ev, fn);
  on("#gFamily", "change", (e) => updateGlobalStyle("family", e.target.value));
  on("#gWeight", "change", (e) => updateGlobalStyle("weight", e.target.value));
  on("#gColor", "input", (e) => updateGlobalStyle("color", e.target.value));
  on("#gTransform", "change", (e) => updateGlobalStyle("textTransform", e.target.value));
  on("#gItalic", "change", (e) => updateGlobalStyle("italic", e.target.checked));
  on("#gAlign", "change", (e) => updateGlobalStyle("align", e.target.value));
  on("#gValign", "change", (e) => updateGlobalStyle("valign", e.target.value));
  on("#gAutoFit", "change", (e) => updateGlobalStyle("autoFit", e.target.checked));
  on("#gSize", "input", (e) => {
    updateGlobalStyle("size", Number(e.target.value) || g.size);
    if (state.settings.style.autoFit) {
      state.settings.style.autoFit = false;
      const cb = els.globalFields.querySelector("#gAutoFit");
      if (cb) cb.checked = false;
      for (const page of state.pages) for (const r of page.regions) if (!r.custom) r.style.autoFit = false;
      renderOverlay();
      renderFields();
      persistSoon();
    }
  });
}

function setStatus(msg, spinner = false, ok = false) {
  els.status.innerHTML = `${spinner ? '<span class="spinner"></span>' : ""}<span style="${ok ? "color:var(--ok)" : ""}">${escapeHtml(
    msg,
  )}</span>`;
}

function setBusy(v) {
  busy = v;
  for (const id of ["btnDetect", "btnOcr", "btnTranslate", "btnInpaint", "btnExportZip", "btnAddImages", "btnOpen"]) {
    const b = $(id);
    if (b) b.disabled = v;
  }
}

let projectDirty = false;
async function schedulePersist() {
  projectDirty = true;
  await persist(state).catch((e) => console.warn("persist failed", e));
}

const persistSoon = debounce(() => schedulePersist(), 600);

/* ---------------- Page rendering ---------------- */

async function renderPages() {
  const prevScroll = els.pagesList.scrollTop;
  els.pagesList.innerHTML = "";
  for (let i = 0; i < state.pages.length; i++) {
    const page = state.pages[i];
    const div = document.createElement("div");
    div.className = "page-thumb" + (page.id === state.activeId ? " active" : "");
    div.dataset.id = page.id;
    if (page.width && page.height) div.style.aspectRatio = `${page.width} / ${page.height}`;
    const status = pageStatus(page);
    const count = (page.regions || []).filter((r) => (r.text || "").trim() && !r.style.keep).length;
    div.innerHTML = `
      <img ${page.thumb ? `src="${page.thumb}"` : ""} alt="">
      <span class="num ${status}" title="${STATUS_LABEL[status]}">${i + 1}</span>
      <button class="del" title="Xoá trang">×</button>
      ${page.sourceUrl ? '<button class="copy" title="Sao chép URL nguồn">URL</button>' : ""}
      ${page.cleanBlob ? '<span class="badge ai" title="Đã xoá chữ bằng AI">AI</span>' : ""}
      ${count ? `<span class="badge" title="${count} vùng đã dịch">${count}</span>` : ""}`;
    if (!page.thumb) queueThumb(page, div.querySelector("img"));
    div.addEventListener("click", (e) => {
      if (e.target.closest(".del")) {
        removePage(page.id);
        return;
      }
      if (e.target.closest(".copy")) {
        copyPageUrl(page.id);
        return;
      }
      setActivePage(page.id);
    });
    els.pagesList.appendChild(div);
  }
  // giữ nguyên vị trí cuộn của danh sách (không nhảy về đầu khi đổi trang)
  els.pagesList.scrollTop = prevScroll;
  const activeThumb = els.pagesList.querySelector(".page-thumb.active");
  if (activeThumb) activeThumb.scrollIntoView({ block: "nearest" });
  updatePageInfo();
}

let thumbQueue = [];
let thumbRunning = 0;
function queueThumb(page, imgEl) {
  if (!imgEl || page.thumb) return;
  thumbQueue.push({ page, imgEl });
  pumpThumbs();
}
function pumpThumbs() {
  const MAX = 3;
  while (thumbRunning < MAX && thumbQueue.length) {
    const { page, imgEl } = thumbQueue.shift();
    if (page.thumb) {
      if (imgEl.isConnected) imgEl.src = page.thumb;
      continue;
    }
    thumbRunning++;
    getPageImage(page)
      .then(({ img }) => {
        if (!page.thumb) page.thumb = makeThumb(img);
        if (imgEl.isConnected) imgEl.src = page.thumb;
        persistSoon();
      })
      .catch(() => {})
      .finally(() => {
        thumbRunning--;
        pumpThumbs();
      });
  }
}
const STATUS_LABEL = { empty: "chưa nhận diện", none: "chưa dịch", partial: "dở dang", done: "đã dịch" };

function pageStatus(page) {
  const regions = page.regions || [];
  if (!regions.length) return "empty";
  const active = regions.filter((r) => !r.style.keep);
  if (!active.length) return "done";
  const translated = active.filter((r) => (r.text || "").trim()).length;
  if (translated === 0) return "none";
  if (translated < active.length) return "partial";
  return "done";
}

function updatePageBadge(pageId) {
  const page = state.pages.find((p) => p.id === pageId);
  const el = els.pagesList.querySelector(`.page-thumb[data-id="${pageId}"]`);
  if (!page || !el) return;
  const status = pageStatus(page);
  const num = el.querySelector(".num");
  if (num) {
    num.className = `num ${status}`;
    num.title = STATUS_LABEL[status];
  }
  const count = (page.regions || []).filter((r) => (r.text || "").trim() && !r.style.keep).length;
  let badge = el.querySelector(".badge:not(.ai)");
  if (count) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "badge";
      el.appendChild(badge);
    }
    badge.textContent = count;
    badge.title = `${count} vùng đã dịch`;
  } else if (badge) {
    badge.remove();
  }
}

async function setActivePage(id) {
  if (state.activeId === id) return;
  state.activeId = id;
  selectedId = null;
  await renderActive();
  renderPages();
  persistSoon();
}

async function renderActive() {
  const page = activePage();
  if (!page) {
    els.pageImg.removeAttribute("src");
    els.overlay.innerHTML = "";
    els.emptyHint.classList.remove("hidden");
    els.pageInfo.textContent = "";
    renderRegionsList();
    renderFields();
    return;
  }
  els.emptyHint.classList.add("hidden");
  setStatus("Đang tải trang…", true);
  const { img } = await getPageImage(page);
  els.pageImg.src = img.src;
  page.width = img.naturalWidth;
  page.height = img.naturalHeight;
  if (!page.thumb) page.thumb = makeThumb(img);
  applyScale();
  els.pageInfo.textContent = `${img.naturalWidth}×${img.naturalHeight}px · ${page.regions.length} vùng`;
  setStatus("Sẵn sàng");
  renderOverlay();
  renderRegionsList();
  renderFields();
}

function fitScale() {
  const page = activePage();
  if (!page) return 1;
  const rect = els.stageScroll.getBoundingClientRect();
  const availW = rect.width - 36;
  const availH = rect.height - 36;
  return clamp(Math.min(availW / page.width, availH / page.height), 0.05, 4);
}

function applyScale() {
  const page = activePage();
  if (!page) return;
  if (state.display.fit) state.display.scale = fitScale();
  const s = state.display.scale;
  els.pageImg.style.width = `${page.width * s}px`;
  els.pageImg.style.height = `${page.height * s}px`;
  els.stage.style.width = `${page.width * s}px`;
  els.stage.style.height = `${page.height * s}px`;
  els.zoomLabel.textContent = `${Math.round(s * 100)}%`;
  // khung đối chiếu hiển thị cùng tỉ lệ với bản gốc
  els.resultStage.style.width = `${page.width * s}px`;
  els.resultStage.style.height = `${page.height * s}px`;
  els.resultCanvas.style.width = `${page.width * s}px`;
  els.resultCanvas.style.height = `${page.height * s}px`;
  scheduleResult();
}

function zoomToRegion(r) {
  const b = regionBounds(r);
  const s = clamp(
    Math.min((els.stageScroll.clientWidth - 60) / (b.w + 40), (els.stageScroll.clientHeight - 60) / (b.h + 40)),
    0.2,
    10,
  );
  state.display.fit = false;
  state.display.scale = s;
  applyScale();
  renderOverlay();
  requestAnimationFrame(() => {
    const sc = els.stageScroll;
    sc.scrollLeft = (b.x + b.w / 2) * s - sc.clientWidth / 2;
    sc.scrollTop = (b.y + b.h / 2) * s - sc.clientHeight / 2;
  });
  setStatus(`Đã zoom vào vùng (${Math.round(s * 100)}%). Bấm “Vừa” để xem toàn trang.`);
}

/* ---------------- Result (khung đối chiếu) ---------------- */
let resultRaf = null;
function scheduleResult() {
  if (!state.display.compare) return;
  if (resultRaf) cancelAnimationFrame(resultRaf);
  resultRaf = requestAnimationFrame(() => {
    resultRaf = null;
    renderResult();
  });
}

async function renderResult() {
  const page = activePage();
  if (!page) return;
  const img = await workingImage(page);
  const originalImage = page.cleanBlob ? (await getPageImage(page)).img : null;
  const canvas = renderPage(img, page.regions, { skipErase: !!page.cleanBlob, originalImage });
  els.resultCanvas.width = canvas.width;
  els.resultCanvas.height = canvas.height;
  const ctx = els.resultCanvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(canvas, 0, 0);
  els.resultStage.style.width = `${canvas.width * state.display.scale}px`;
  els.resultStage.style.height = `${canvas.height * state.display.scale}px`;
  els.resultCanvas.style.width = `${canvas.width * state.display.scale}px`;
  els.resultCanvas.style.height = `${canvas.height * state.display.scale}px`;
}

/* ---------------- Overlay ---------------- */

function regionClass(r) {
  return r.cls === "text_bubble" ? "" : r.cls;
}

const SVGNS = "http://www.w3.org/2000/svg";

function rectFillDiv(r) {
  const sh = eraseShape(r);
  if (!sh || sh.kind !== "rect") return null;
  const el = document.createElement("div");
  el.className = "box filled";
  el.dataset.fill = r.id;
  el.style.background = r.style.fillColor;
  el.style.border = "none";
  el.style.cursor = "default";
  return el;
}
function positionFill(el, r, s) {
  const sh = eraseShape(r);
  if (!sh) {
    el.style.display = "none";
    return;
  }
  if (sh.kind === "poly" || sh.rot) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.style.left = `${sh.x * s}px`;
  el.style.top = `${sh.y * s}px`;
  el.style.width = `${sh.w * s}px`;
  el.style.height = `${sh.h * s}px`;
}

function makePreview(r, w, h, c, ang, s) {
  const pv = document.createElement("div");
  pv.className = "preview";
  pv.style.position = "absolute";
  pv.style.left = `${(c.x - w / 2) * s}px`;
  pv.style.top = `${(c.y - h / 2) * s}px`;
  pv.style.width = `${w * s}px`;
  pv.style.height = `${h * s}px`;
  if (ang) {
    pv.style.transform = `rotate(${ang}deg)`;
    pv.style.transformOrigin = "center";
  }
  pv.style.display = "flex";
  pv.style.pointerEvents = "none";
  pv.style.overflow = "hidden";
  pv.style.alignItems = r.style.valign === "top" ? "flex-start" : r.style.valign === "bottom" ? "flex-end" : "center";
  pv.style.justifyContent = r.style.align === "left" ? "flex-start" : r.style.align === "right" ? "flex-end" : "center";
  pv.style.textAlign = r.style.align;
  const layout = fitPreview(r);
  const fs = layout.size * s;
  pv.style.font = `${r.style.italic ? "italic " : ""}${r.style.weight} ${fs}px ${r.style.family}`;
  pv.style.lineHeight = `${layout.lh * s}px`;
  pv.style.color = r.style.color;
  pv.style.whiteSpace = "pre";
  if (r.style.outline && r.style.outlineWidth > 0) {
    pv.style.webkitTextStroke = `${r.style.outlineWidth * s}px ${r.style.outlineColor || "#fff"}`;
    pv.style.paintOrder = "stroke";
  }
  pv.textContent = layout.lines.join("\n");
  return pv;
}

function renderOverlay() {
  const page = activePage();
  const s = state.display.scale;
  scheduleResult();
  if (!page || !state.display.showBoxes) {
    els.overlay.innerHTML = "";
    return;
  }
  const W = page.width;
  const H = page.height;
  const frag = document.createDocumentFragment();
  const showResultOnOrig = !state.display.compare;

  // 1) vùng tô nền cho hình chữ nhật (kể cả xoay) — dùng DOM để kéo mượt
  if (showResultOnOrig) {
    for (const r of page.regions) {
      if (r.shape === "quad") continue;
      const sh = eraseShape(r);
      if (!sh || sh.kind !== "rect") continue;
      const fill = document.createElement("div");
      fill.className = "box filled";
      fill.dataset.fill = r.id;
      fill.style.background = r.style.fillColor;
      fill.style.border = "none";
      fill.style.cursor = "default";
      if (sh.rot) {
        fill.style.left = `${(sh.cx - sh.w / 2) * s}px`;
        fill.style.top = `${(sh.cy - sh.h / 2) * s}px`;
        fill.style.width = `${sh.w * s}px`;
        fill.style.height = `${sh.h * s}px`;
        fill.style.transform = `rotate(${sh.rot}deg)`;
        fill.style.transformOrigin = "center";
      } else {
        fill.style.left = `${sh.x * s}px`;
        fill.style.top = `${sh.y * s}px`;
        fill.style.width = `${sh.w * s}px`;
        fill.style.height = `${sh.h * s}px`;
      }
      frag.appendChild(fill);
    }
  }

  // 2) layer SVG cho hình tứ giác (fill + viền + tay cầm)
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W * s);
  svg.setAttribute("height", H * s);
  svg.style.position = "absolute";
  svg.style.left = "0";
  svg.style.top = "0";
  svg.style.pointerEvents = "none";

  for (const r of page.regions) {
    if (r.shape !== "quad" || !r.quad) continue;
    const selected = r.id === selectedId;
    if (showResultOnOrig && r.style.fill && r.style.eraseMode !== "none" && !r.style.keep) {
      const f = document.createElementNS(SVGNS, "polygon");
      f.setAttribute("points", r.quad.map((p) => `${p[0]},${p[1]}`).join(" "));
      f.setAttribute("fill", r.style.fillColor || "#fff");
      svg.appendChild(f);
    }
    const poly = document.createElementNS(SVGNS, "polygon");
    poly.setAttribute(
      "class",
      "quad-poly" + (selected ? " selected" : "") + (r.style.keep ? " keep" : ""),
    );
    poly.dataset.id = r.id;
    poly.setAttribute("points", r.quad.map((p) => `${p[0]},${p[1]}`).join(" "));
    poly.setAttribute("fill", "rgba(59,130,246,0.10)");
    poly.setAttribute("stroke", r.style.keep ? "#8a8a92" : "#3b82f6");
    if (r.style.keep) poly.setAttribute("stroke-dasharray", `${6 / s} ${4 / s}`);
    poly.setAttribute("stroke-width", 1.5 / s);
    poly.style.pointerEvents = "auto";
    poly.style.cursor = "move";
    svg.appendChild(poly);
    if (selected) {
      r.quad.forEach((p, i) => {
        const c = document.createElementNS(SVGNS, "circle");
        c.setAttribute("class", "quad-handle");
        c.dataset.id = r.id;
        c.dataset.i = String(i);
        c.setAttribute("cx", p[0]);
        c.setAttribute("cy", p[1]);
        c.setAttribute("r", 6 / s);
        c.setAttribute("stroke-width", 1.5 / s);
        c.style.pointerEvents = "auto";
        c.style.cursor = "crosshair";
        svg.appendChild(c);
      });
    }
  }
  frag.appendChild(svg);

  // 3) khung chữ nhật (DOM box) + preview + tay cầm
  for (const r of page.regions) {
    if (r.shape === "quad") {
      if (showResultOnOrig && r.text && !r.style.keep) {
        const size = regionSize(r);
        frag.appendChild(makePreview(r, size.w, size.h, regionCenter(r), regionAngleDeg(r), s));
      }
      continue;
    }
    const box = document.createElement("div");
    box.className = `box ${regionClass(r)}${r.style.keep ? " keep" : ""}${r.id === selectedId ? " selected" : ""}`;
    box.dataset.id = r.id;
    box.style.left = `${r.x * s}px`;
    box.style.top = `${r.y * s}px`;
    box.style.width = `${r.w * s}px`;
    box.style.height = `${r.h * s}px`;
    if (r.rot) {
      box.style.transform = `rotate(${r.rot}deg)`;
      box.style.transformOrigin = "center";
    }
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `${r.style.keep ? "Giữ nguyên · " : ""}${CLASS_LABEL_VI[r.cls] || r.cls}${
      r.source ? " • " + r.source.slice(0, 18) : ""
    }`;
    box.appendChild(tag);
    if (showResultOnOrig && r.text && !r.style.keep) {
      const pv = makePreview(r, r.w, r.h, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, 0, s);
      pv.style.position = "absolute";
      pv.style.left = "0";
      pv.style.top = "0";
      pv.style.width = "100%";
      pv.style.height = "100%";
      pv.style.transform = "";
      box.appendChild(pv);
    }
    for (const dir of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const h = document.createElement("div");
      h.className = `handle ${dir}`;
      h.dataset.dir = dir;
      box.appendChild(h);
    }
    const rh = document.createElement("div");
    rh.className = "handle rot";
    rh.dataset.dir = "rot";
    rh.title = "Xoay (giữ Shift để bắt góc 15°)";
    box.appendChild(rh);
    frag.appendChild(box);
  }

  els.overlay.innerHTML = "";
  els.overlay.appendChild(frag);
}

function fitPreview(r) {
  return computeLayout(r);
}

/* ---------------- Overlay interaction ---------------- */

function toImageCoords(e) {
  const rect = els.stage.getBoundingClientRect();
  const s = state.display.scale;
  return { x: (e.clientX - rect.left) / s, y: (e.clientY - rect.top) / s };
}

let drag = null;
let drawStart = null;
let drawEnd = null;
let lastClick = { id: null, t: 0 };

els.overlay.addEventListener("pointerdown", (e) => {
  if (busy) return;
  const quadH = e.target.closest(".quad-handle");
  const quadPoly = e.target.closest(".quad-poly");
  if (quadH) {
    const region = activePage().regions.find((r) => r.id === quadH.dataset.id);
    if (!region) return;
    if (region.id !== selectedId) select(region.id);
    drag = { mode: "quadCorner", region, corner: Number(quadH.dataset.i) };
    e.preventDefault();
    return;
  }
  if (quadPoly && !drawMode) {
    const region = activePage().regions.find((r) => r.id === quadPoly.dataset.id);
    if (!region) return;
    if (region.id !== selectedId) select(region.id);
    const now = performance.now();
    if (lastClick.id === region.id && now - lastClick.t < 350) {
      lastClick = { id: null, t: 0 };
      zoomToRegion(region);
      return;
    }
    lastClick = { id: region.id, t: now };
    drag = { mode: "quadMove", region, start: toImageCoords(e), origQuad: region.quad.map((p) => [p[0], p[1]]) };
    e.preventDefault();
    return;
  }
  const handle = e.target.closest(".handle");
  const boxEl = e.target.closest(".box[data-id]");
  if (drawMode || !boxEl) {
    if (drawMode) {
      drawStart = toImageCoords(e);
      drawEnd = drawStart;
      e.preventDefault();
    } else if (!boxEl) {
      select(null);
    }
    return;
  }
  const region = activePage().regions.find((r) => r.id === boxEl.dataset.id);
  if (!region) return;
  if (region.id !== selectedId) select(region.id);
  // double-click thủ công (không phụ thuộc sự kiện dblclick)
  const now = performance.now();
  if (!handle && lastClick.id === region.id && now - lastClick.t < 350) {
    lastClick = { id: null, t: 0 };
    zoomToRegion(region);
    return;
  }
  if (!handle) lastClick = { id: region.id, t: now };
  const liveBox = els.overlay.querySelector(`.box[data-id="${region.id}"]`);
  const dir = handle?.dataset.dir || "move";
  drag = {
    mode: dir === "rot" ? "rotate" : dir === "move" ? "move" : "resize",
    dir,
    region,
    start: toImageCoords(e),
    orig: { x: region.x, y: region.y, w: region.w, h: region.h, rot: region.rot || 0 },
    boxEl: liveBox,
    fillEl: els.overlay.querySelector(`[data-fill="${region.id}"]`),
  };
  e.preventDefault();
});

function syncQuadBbox(r) {
  const b = regionBounds(r);
  r.x = Math.round(b.x);
  r.y = Math.round(b.y);
  r.w = Math.round(b.w);
  r.h = Math.round(b.h);
}

function addVertex(r) {
  const q = r.quad;
  if (!q) return;
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < q.length; i++) {
    const a = q[i];
    const b = q[(i + 1) % q.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  const a = q[best];
  const b = q[(best + 1) % q.length];
  q.splice(best + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  syncQuadBbox(r);
  renderOverlay();
  renderFields();
  schedulePersist();
}

function removeVertex(r) {
  if (!r.quad || r.quad.length <= 3) return;
  r.quad.pop();
  syncQuadBbox(r);
  renderOverlay();
  renderFields();
  schedulePersist();
}

window.addEventListener("pointermove", (e) => {
  if (drawStart) {
    drawEnd = toImageCoords(e);
    updateDrawGhost(drawStart, drawEnd);
    return;
  }
  if (!drag) return;
  const s = state.display.scale;
  const p = toImageCoords(e);
  const r = drag.region;

  if (drag.mode === "quadCorner") {
    r.quad[drag.corner] = [Math.round(p.x), Math.round(p.y)];
    syncQuadBbox(r);
    renderOverlay();
    e.preventDefault();
    return;
  }
  if (drag.mode === "quadMove") {
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    r.quad = drag.origQuad.map((q) => [Math.round(q[0] + dx), Math.round(q[1] + dy)]);
    syncQuadBbox(r);
    renderOverlay();
    e.preventDefault();
    return;
  }
  if (drag.mode === "rotate") {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    let ang = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
    ang = e.shiftKey ? Math.round(ang / 15) * 15 : Math.round(ang);
    r.rot = ((ang + 180) % 360) - 180;
    renderOverlay();
    e.preventDefault();
    return;
  }

  const dx = p.x - drag.start.x;
  const dy = p.y - drag.start.y;
  if (drag.mode === "move") {
    r.x = Math.round(drag.orig.x + dx);
    r.y = Math.round(drag.orig.y + dy);
  } else if (drag.mode === "resize") {
    const a = ((drag.orig.rot || 0) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const R = (px, py) => [px * cos - py * sin, px * sin + py * cos];
    const Rinv = (px, py) => [px * cos + py * sin, -px * sin + py * cos];
    const ocx = drag.orig.x + drag.orig.w / 2;
    const ocy = drag.orig.y + drag.orig.h / 2;
    const dir = drag.dir;
    const signX = dir.includes("w") ? 1 : dir.includes("e") ? -1 : 0;
    const signY = dir.includes("n") ? 1 : dir.includes("s") ? -1 : 0;
    const [alx, aly] = R((signX * drag.orig.w) / 2, (signY * drag.orig.h) / 2);
    const awx = ocx + alx;
    const awy = ocy + aly;
    const [lpx, lpy] = Rinv(p.x - awx, p.y - awy);
    let nw = signX !== 0 ? Math.abs(lpx) : drag.orig.w;
    let nh = signY !== 0 ? Math.abs(lpy) : drag.orig.h;
    nw = Math.max(12, nw);
    nh = Math.max(12, nh);
    const [nalx, naly] = R(signX !== 0 ? (signX * nw) / 2 : 0, signY !== 0 ? (signY * nh) / 2 : 0);
    const ncx = awx - nalx;
    const ncy = awy - naly;
    r.w = Math.round(nw);
    r.h = Math.round(nh);
    r.x = Math.round(ncx - nw / 2);
    r.y = Math.round(ncy - nh / 2);
  }
  positionBox(drag.boxEl, r, s);
  if (drag.fillEl) positionFill(drag.fillEl, r, s);
  e.preventDefault();
});

window.addEventListener("pointerup", () => {
  if (drawStart) {
    finishDraw(drawStart, drawEnd || drawStart);
    drawStart = null;
    drawEnd = null;
    return;
  }
  if (drag) {
    drag = null;
    renderOverlay();
    renderRegionsList();
    renderFields();
    schedulePersist();
  }
});

function positionBox(el, r, s) {
  if (!el) return;
  el.style.left = `${r.x * s}px`;
  el.style.top = `${r.y * s}px`;
  el.style.width = `${r.w * s}px`;
  el.style.height = `${r.h * s}px`;
}

let ghostEl = null;
function updateDrawGhost(a, b) {
  if (!ghostEl) {
    ghostEl = document.createElement("div");
    ghostEl.className = "box manual selected";
    els.overlay.appendChild(ghostEl);
  }
  const s = state.display.scale;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  positionBox(ghostEl, { x, y, w, h }, s);
}

function finishDraw(a, b) {
  ghostEl?.remove();
  ghostEl = null;
  let x = Math.min(a.x, b.x);
  let y = Math.min(a.y, b.y);
  let w = Math.abs(a.x - b.x);
  let h = Math.abs(a.y - b.y);
  if (w < 16 || h < 16) {
    x = a.x;
    y = a.y;
    w = 160;
    h = 90;
  }
  const page = activePage();
  if (!page) return;
  const region = makeRegion({ cls: "manual", box: { x, y, w, h } });
  applyGlobalToRegion(region);
  page.regions.push(region);
  selectedId = region.id;
  drawMode = false;
  $("btnAddRegion").classList.remove("primary");
  renderOverlay();
  renderRegionsList();
  renderFields();
  persistSoon();
}

function toggleKeep() {
  const r = activeRegion();
  if (!r) return;
  r.style.keep = !r.style.keep;
  renderOverlay();
  renderRegionsList();
  renderFields();
  if (activePage()) updatePageBadge(activePage().id);
  updatePageInfo();
  schedulePersist();
  setStatus(r.style.keep ? "Đã giữ nguyên vùng (không dịch/xoá)." : "Đã bỏ giữ nguyên.", false, true);
}

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

  // Giữ nguyên: K khi không gõ chữ, hoặc Alt+K khi đang gõ.
  const isK = e.code === "KeyK" || (e.key || "").toLowerCase() === "k";
  if (selectedId && isK && (!typing || e.altKey)) {
    e.preventDefault();
    toggleKeep();
    return;
  }
  if (typing) return;
  if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
    e.preventDefault();
    deleteRegion(selectedId);
  }
});

/* ---------------- Regions ---------------- */

function select(id) {
  selectedId = id;
  renderOverlay();
  renderRegionsList();
  renderFields();
}

function deleteRegion(id) {
  const page = activePage();
  if (!page) return;
  page.regions = page.regions.filter((r) => r.id !== id);
  if (selectedId === id) selectedId = null;
  renderOverlay();
  renderRegionsList();
  renderFields();
  updatePageInfo();
  renderPages();
  persistSoon();
}

function renderRegionsList() {
  const page = activePage();
  els.regionList.innerHTML = "";
  if (!page || !page.regions.length) {
    els.regionList.innerHTML = '<p class="muted" style="padding:6px">Chưa có vùng nào.</p>';
    return;
  }
  page.regions.forEach((r, i) => {
    const div = document.createElement("div");
    div.className = "region-item" + (r.id === selectedId ? " active" : "") + (r.style.keep ? " keep" : "");
    const dst = r.style.keep ? "— giữ nguyên —" : r.text || "— chưa dịch —";
    div.innerHTML = `<span class="src">${i + 1}. ${escapeHtml(r.source || CLASS_LABEL_VI[r.cls] || r.cls)}</span>
      <span class="dst">${escapeHtml(dst)}</span>`;
    div.addEventListener("click", () => select(r.id));
    els.regionList.appendChild(div);
  });
}

function renderFields() {
  const r = activeRegion();
  if (!r) {
    els.fields.innerHTML = '<p class="muted">Chọn một vùng trên ảnh để nhập bản dịch.</p>';
    return;
  }
  const fontOptions = FONT_FAMILIES.map(
    (f) => `<option value="${escapeHtml(f.value)}" ${f.value === r.style.family ? "selected" : ""}>${f.label}</option>`,
  ).join("");
  const dis = "";

  function ensureCustom(reg) {
    if (reg.custom) return;
    reg.custom = true;
    const cb = els.fields.querySelector("#fldCustom");
    if (cb) cb.checked = true;
  }

  els.fields.innerHTML = `
    <div class="inline-title">
      <label style="margin:0">Bản dịch</label>
      <span class="cls">${escapeHtml(CLASS_LABEL_VI[r.cls] || r.cls)} · ${r.w}×${r.h}</span>
    </div>
    <div class="custom-row">
      <label><input type="checkbox" id="fldCustom" ${r.custom ? "checked" : ""}/> Tùy chỉnh riêng khung này</label>
      ${r.custom ? '<button id="btnUseGlobal">Dùng kiểu chung</button>' : '<span class="cls">đang dùng kiểu chung</span>'}
    </div>
    <textarea id="fldText" placeholder="Nhập bản dịch của bạn…">${escapeHtml(r.text || "")}</textarea>

    <div>
      <label>Nguyên văn (OCR)</label>
      <textarea id="fldSource" style="min-height:48px" placeholder="Chưa có…">${escapeHtml(r.source || "")}</textarea>
      <div class="region-actions">
        <button id="btnUseSource" style="flex:1">Dùng nguyên văn</button>
      </div>
    </div>

    <div>
      <label>Kiểu chữ</label>
      <select id="fldFamily" ${dis}>${fontOptions}</select>
      <div class="region-actions">
        <button id="btnFamilyAll" style="flex:1" title="Đặt kiểu chữ này cho mọi vùng của tất cả các trang">Áp dụng cho tất cả vùng</button>
      </div>
    </div>

    <div class="grid3">
      <div>
        <label>Cỡ</label>
        <input type="number" id="fldSize" min="7" max="160" value="${r.style.size}" ${dis}/>
      </div>
      <div>
        <label>Kiểu</label>
        <select id="fldWeight" ${dis}>
          <option value="400" ${r.style.weight === "400" ? "selected" : ""}>Thường</option>
          <option value="700" ${r.style.weight === "700" ? "selected" : ""}>Đậm</option>
        </select>
      </div>
      <div>
        <label>Màu</label>
        <input type="color" id="fldColor" value="${r.style.color}" ${dis}/>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Dạng chữ</label>
        <select id="fldTransform" ${dis}>
          <option value="none" ${r.style.textTransform === "none" ? "selected" : ""}>Bình thường</option>
          <option value="uppercase" ${r.style.textTransform === "uppercase" ? "selected" : ""}>IN HOA</option>
          <option value="lowercase" ${r.style.textTransform === "lowercase" ? "selected" : ""}>in thường</option>
          <option value="capitalize" ${r.style.textTransform === "capitalize" ? "selected" : ""}>Viết Hoa</option>
        </select>
      </div>
      <label class="inline" style="text-transform:none;color:var(--text);align-self:flex-end;padding-bottom:7px">
        <input type="checkbox" id="fldItalic" ${r.style.italic ? "checked" : ""} ${dis}/> In nghiêng
      </label>
    </div>

    <div class="row">
      <div>
        <label>Ngang</label>
        <select id="fldAlign" ${dis}>
          <option value="left" ${r.style.align === "left" ? "selected" : ""}>Trái</option>
          <option value="center" ${r.style.align === "center" ? "selected" : ""}>Giữa</option>
          <option value="right" ${r.style.align === "right" ? "selected" : ""}>Phải</option>
        </select>
      </div>
      <div>
        <label>Dọc</label>
        <select id="fldValign" ${dis}>
          <option value="top" ${r.style.valign === "top" ? "selected" : ""}>Trên</option>
          <option value="middle" ${r.style.valign === "middle" ? "selected" : ""}>Giữa</option>
          <option value="bottom" ${r.style.valign === "bottom" ? "selected" : ""}>Dưới</option>
        </select>
      </div>
    </div>

    <label class="inline" style="text-transform:none;color:var(--text)">
      <input type="checkbox" id="fldAutoFit" ${r.style.autoFit ? "checked" : ""} ${dis}/> Tự co chữ cho vừa
    </label>

    <label class="inline" style="text-transform:none;color:var(--text)" title="Không dịch, không xoá nền, không vẽ đè vùng này — giữ nguyên nét gốc (ví dụ tên riêng). Phím tắt: K (hoặc Alt+K khi đang gõ)">
      <input type="checkbox" id="fldKeep" ${r.style.keep ? "checked" : ""}/> Giữ nguyên (tên riêng — không dịch/xoá)
    </label>

    <div class="row">
      <div>
        <label title="Xoay CHỮ theo độ (đa giác: chữ không tự xoay khi kéo đỉnh)">Xoay chữ (°)</label>
        <input type="number" id="fldRot" min="-180" max="180" step="1" value="${Math.round(r.rot || 0)}"/>
      </div>
      <label class="inline" style="text-transform:none;color:var(--text);align-self:flex-end;padding-bottom:7px" title="Kéo các đỉnh để khớp chữ nghiêng/hình thang">
        <input type="checkbox" id="fldQuad" ${r.shape === "quad" ? "checked" : ""}/> Đa giác (4+ đỉnh)
      </label>
    </div>
    ${r.shape === "quad" ? `<div class="region-actions">
      <button id="btnAddVertex" title="Thêm một đỉnh vào cạnh dài nhất">+ Đỉnh</button>
      <button id="btnDelVertex" ${r.quad.length <= 3 ? "disabled" : ""} title="Bỏ đỉnh cuối">− Đỉnh</button>
    </div>` : ""}

    <div>
      <label>Xoá nền gốc</label>
      <select id="fldEraseMode">
        <option value="text" ${r.style.eraseMode === "text" ? "selected" : ""}>Ô chữ — giữ viền bong bóng</option>
        <option value="bubble" ${r.style.eraseMode === "bubble" ? "selected" : ""} ${r.bubble ? "" : "disabled"}>Cả bong bóng</option>
        <option value="none" ${r.style.eraseMode === "none" ? "selected" : ""}>Không xoá</option>
      </select>
    </div>

    <div class="grid3">
      <div>
        <label>Màu nền</label>
        <input type="color" id="fldFillColor" value="${r.style.fillColor}"/>
      </div>
      <div>
        <label title="Chỉ dùng cho 'Cả bong bóng': chừa lại bao nhiêu px để giữ viền/nét">Chừa lề viền</label>
        <input type="number" id="fldInset" min="0" max="60" value="${r.style.eraseInset ?? 0}"/>
      </div>
      <div>
        <label>Mềm viền</label>
        <input type="number" id="fldFeather" min="0" max="20" value="${r.style.feather ?? 0}"/>
      </div>
    </div>

    <div class="row">
      <label class="inline" style="text-transform:none;color:var(--text)">
        <input type="checkbox" id="fldOutline" ${r.style.outline ? "checked" : ""}/> Viền chữ
      </label>
      <input type="color" id="fldOutlineColor" value="${r.style.outlineColor}"/>
      <input type="number" id="fldOutlineWidth" min="0" max="10" value="${r.style.outlineWidth || 2}" style="max-width:64px"/>
    </div>

    <div class="region-actions">
      <button id="btnZoomRegion" style="flex:1" title="Phóng to để đối chiếu kỹ vùng này">Zoom vào vùng</button>
      <button id="btnDeleteRegion" class="danger" style="flex:1">Xoá vùng</button>
    </div>`;

  const on = (id, ev, fn) => els.fields.querySelector(id)?.addEventListener(ev, fn);

  on("#fldText", "input", (e) => {
    r.text = e.target.value;
    renderOverlay();
    renderRegionsList();
    updatePageInfo();
    if (activePage()) updatePageBadge(activePage().id);
    persistSoon();
  });
  on("#fldSource", "input", (e) => {
    r.source = e.target.value;
    persistSoon();
  });
  on("#btnUseSource", "click", () => {
    r.text = r.source;
    renderOverlay();
    renderRegionsList();
    renderFields();
    if (activePage()) updatePageBadge(activePage().id);
    updatePageInfo();
    persistSoon();
  });
  on("#fldCustom", "change", (e) => {
    if (e.target.checked) {
      r.custom = true;
    } else {
      for (const k of GLOBAL_KEYS) r.style[k] = state.settings.style[k];
      r.custom = false;
    }
    renderFields();
    refresh();
  });
  on("#btnUseGlobal", "click", () => {
    for (const k of GLOBAL_KEYS) r.style[k] = state.settings.style[k];
    r.custom = false;
    renderFields();
    refresh();
  });
  on("#fldFamily", "change", (e) => {
    ensureCustom(r);
    r.style.family = e.target.value;
    refresh();
  });
  on("#btnFamilyAll", "click", () => {
    for (const page of state.pages) for (const reg of page.regions) reg.style.family = r.style.family;
    renderOverlay();
    schedulePersist();
    setStatus("Đã đổi kiểu chữ cho tất cả vùng.", false, true);
  });
  on("#fldSize", "input", (e) => {
    ensureCustom(r);
    r.style.size = Number(e.target.value) || r.style.size;
    if (r.style.autoFit) {
      r.style.autoFit = false;
      const cb = els.fields.querySelector("#fldAutoFit");
      if (cb) cb.checked = false;
    }
    refresh();
  });
  on("#fldWeight", "change", (e) => {
    ensureCustom(r);
    r.style.weight = e.target.value;
    refresh();
  });
  on("#fldTransform", "change", (e) => {
    ensureCustom(r);
    r.style.textTransform = e.target.value;
    refresh();
  });
  on("#fldItalic", "change", (e) => {
    ensureCustom(r);
    r.style.italic = e.target.checked;
    refresh();
  });
  on("#fldColor", "input", (e) => {
    ensureCustom(r);
    r.style.color = e.target.value;
    renderOverlay();
    persistSoon();
  });
  on("#fldAlign", "change", (e) => {
    ensureCustom(r);
    r.style.align = e.target.value;
    refresh();
  });
  on("#fldValign", "change", (e) => {
    ensureCustom(r);
    r.style.valign = e.target.value;
    refresh();
  });
  on("#fldAutoFit", "change", (e) => {
    ensureCustom(r);
    r.style.autoFit = e.target.checked;
    renderFields();
    refresh();
  });
  on("#fldKeep", "change", (e) => {
    r.style.keep = e.target.checked;
    renderOverlay();
    renderRegionsList();
    schedulePersist();
  });
  on("#fldRot", "input", (e) => {
    r.rot = Number(e.target.value) || 0;
    refresh();
  });
  on("#fldQuad", "change", (e) => {
    if (e.target.checked) {
      r.shape = "quad";
      r.quad = rectCorners(r);
      syncQuadBbox(r);
    } else {
      r.shape = "rect";
      r.quad = null;
    }
    renderFields();
    refresh();
  });
  on("#btnAddVertex", "click", () => addVertex(r));
  on("#btnDelVertex", "click", () => removeVertex(r));
  on("#fldEraseMode", "change", (e) => {
    r.style.eraseMode = e.target.value;
    r.style.fill = e.target.value !== "none";
    refresh();
  });
  on("#fldFillColor", "input", (e) => {
    r.style.fillColor = e.target.value;
    refresh();
  });
  on("#fldInset", "input", (e) => {
    r.style.eraseInset = Math.max(0, Number(e.target.value) || 0);
    refresh();
  });
  on("#fldFeather", "input", (e) => {
    r.style.feather = Math.max(0, Number(e.target.value) || 0);
    refresh();
  });
  on("#fldOutline", "change", (e) => {
    r.style.outline = e.target.checked;
    refresh();
  });
  on("#fldOutlineColor", "input", (e) => {
    r.style.outlineColor = e.target.value;
    refresh();
  });
  on("#fldOutlineWidth", "input", (e) => {
    r.style.outlineWidth = Math.max(0, Number(e.target.value) || 0);
    refresh();
  });
  on("#btnDeleteRegion", "click", () => deleteRegion(r.id));
  on("#btnZoomRegion", "click", () => zoomToRegion(r));
}

const refresh = debounce(() => {
  renderOverlay();
  persistSoon();
}, 120);

function updatePageInfo() {
  const page = activePage();
  const total = state.pages.length;
  let done = 0;
  for (const p of state.pages) if (pageStatus(p) === "done") done++;
  const active = page ? `${page.width}×${page.height}px · ${page.regions.length} vùng · ` : "";
  els.pageInfo.textContent = total ? `${active}${done}/${total} trang đã dịch` : "";
}

/* ---------------- Detection ---------------- */

async function runDetect() {
  const page = activePage();
  if (!page || busy) return;
  const { img } = await getPageImage(page);
  setBusy(true);
  setStatus("Đang tải model nhận diện…", true);
  try {
    const dets = await detect(img, {
      threshold: Number(els.threshold.value),
      onProgress: ({ phase, ratio }) => {
        if (phase === "download") setStatus(`Đang tải model… ${Math.round(ratio * 100)}%`, true);
        else setStatus("Đang khởi tạo model…", true);
      },
    });
    setStatus(`Nhận diện xong: ${dets.length} đối tượng. Đang tạo vùng…`, true);
    const regions = buildRegions(dets);
    regions.forEach(applyGlobalToRegion);
    page.regions = regions;
    selectedId = null;
    renderOverlay();
    renderRegionsList();
    renderFields();
    updatePageInfo();
    renderPages();
    schedulePersist();
    setStatus(`Đã tạo ${regions.length} vùng dịch.`, false, true);
  } catch (err) {
    console.error(err);
    setStatus(`Lỗi nhận diện: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

/* ---------------- OCR ---------------- */

function joinLine(words) {
  let out = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i].text;
    if (i === 0) {
      out = w;
      continue;
    }
    const prev = out[out.length - 1] || "";
    const bothCjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(prev) &&
      /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(w[0] || "");
    out += (bothCjk ? "" : " ") + w;
  }
  return out;
}

function assignWordsToRegions(regions, words) {
  for (const r of regions) {
    const inBox = words.filter((w) => containsPoint(r, center(w)));
    if (!inBox.length) continue;
    inBox.sort((a, b) => center(a).y - center(b).y || a.x - b.x);
    const lines = [];
    for (const w of inBox) {
      const cy = center(w).y;
      const line = lines.find((l) => Math.abs(l.cy - cy) < Math.max(w.h * 0.7, 8));
      if (line) {
        line.words.push(w);
        line.cy = (line.cy * (line.words.length - 1) + cy) / line.words.length;
      } else {
        lines.push({ cy, words: [w] });
      }
    }
    lines.sort((a, b) => a.cy - b.cy);
    r.source = lines
      .map((l) => joinLine(l.words.sort((a, b) => a.x - b.x)))
      .join("\n")
      .trim();
  }
}

function looksGarbled(text) {
  const t = (text || "").trim();
  if (t.length < 6) return false;
  const letters = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  return letters / t.length < 0.5;
}

async function runOcr() {
  const page = activePage();
  if (!page || busy) return;
  if (!page.regions.length) {
    setStatus("Chưa có vùng nào. Hãy bấm “Nhận diện” trước.");
    return;
  }
  const { img } = await getPageImage(page);
  const lang = els.ocrLang.value;
  const mode = state.settings.ocrMode || "region";
  setBusy(true);
  try {
    if (mode === "region") {
      const targets = page.regions.filter((r) => !r.style.keep);
      for (let i = 0; i < targets.length; i++) {
        setStatus(`OCR theo vùng ${i + 1}/${targets.length}…`, true);
        const r = targets[i];
        try {
          r.source = await ocrCanvas(img, { x: r.x, y: r.y, w: r.w, h: r.h }, { lang, padding: 8 });
        } catch {
          /* giữ nguyên văn cũ nếu lỗi */
        }
        await nextFrame();
      }
    } else {
      const { words } = await recognize(img, {
        lang,
        onProgress: ({ phase, ratio }) => setStatus(`OCR (${phase})… ${Math.round(ratio * 100)}%`, true),
      });
      assignWordsToRegions(page.regions, words);
    }
    renderOverlay();
    renderRegionsList();
    renderFields();
    schedulePersist();
    const garbled = page.regions.filter((r) => looksGarbled(r.source)).length;
    if (garbled >= Math.max(2, Math.ceil(page.regions.length * 0.4))) {
      setStatus(
        `OCR xong nhưng ${garbled} vùng có vẻ sai — kiểm tra "Ngôn ngữ" phải đúng ngôn ngữ GỐC của truyện.`,
      );
    } else {
      setStatus(`OCR xong (${lang}, ${mode === "region" ? "theo vùng" : "cả trang"}). Chỉnh lại nguyên văn nếu cần.`, false, true);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Lỗi OCR: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

/* ---------------- Dịch: offline (Transformers.js) hoặc Gemini ---------------- */

async function runTranslate() {
  const provider = state.settings.transProvider || "offline";
  if (provider === "gemini") return runGeminiTranslate();
  return runOfflineTranslate();
}

async function runOfflineTranslate() {
  const page = activePage();
  if (!page || busy) return;
  const dir = els.transDir.value;
  const targets = page.regions.filter(
    (r) => (r.source || "").trim() && !(r.text || "").trim() && !r.style.keep,
  );
  if (!targets.length) {
    setStatus("Không có vùng nào cần dịch (cần OCR nguyên văn trước, hoặc mọi vùng đã có bản dịch).");
    return;
  }
  setBusy(true);
  try {
    setStatus("Đang tải model dịch (chỉ lần đầu)…", true);
    const texts = targets.map((r) => (r.source || "").replace(/\s*\n\s*/g, " ").trim());
    const out = await translateBatch(texts, dir, ({ ratio }) =>
      setStatus(`Đang tải model dịch… ${Math.round(ratio * 100)}%`, true),
    );
    targets.forEach((r, i) => {
      const t = out[i] || "";
      if (t) r.text = t;
    });
    renderOverlay();
    renderRegionsList();
    renderFields();
    updatePageInfo();
    schedulePersist();
    setStatus(`Đã gợi ý dịch ${targets.length} vùng (${DIRECTIONS[dir]?.label || dir}). Sửa lại nếu cần.`, false, true);
  } catch (err) {
    console.error(err);
    setStatus(`Lỗi dịch: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

// Vẽ ảnh trang + khung đỏ đánh số quanh từng vùng để gửi cho Gemini.
async function buildNumberedImage(page, targets) {
  const { img } = await getPageImage(page);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const s = Math.min(1, 1400 / Math.max(W, H));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * s);
  canvas.height = Math.round(H * s);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const lw = Math.max(2, Math.round(3 * s));
  const fs = Math.max(16, Math.round(20 * s));
  ctx.lineWidth = lw;
  ctx.font = `bold ${fs}px sans-serif`;
  ctx.textBaseline = "middle";
  targets.forEach((r, i) => {
    const b = regionBounds(r);
    const x = b.x * s;
    const y = b.y * s;
    const w = b.w * s;
    const h = b.h * s;
    ctx.strokeStyle = "#e11d48";
    if (r.shape === "quad" && r.quad) {
      ctx.beginPath();
      r.quad.forEach((pt, k) => (k ? ctx.lineTo(pt[0] * s, pt[1] * s) : ctx.moveTo(pt[0] * s, pt[1] * s)));
      ctx.closePath();
      ctx.stroke();
    } else if (r.rot) {
      const corners = rectCorners(r);
      ctx.beginPath();
      corners.forEach((pt, k) => (k ? ctx.lineTo(pt[0] * s, pt[1] * s) : ctx.moveTo(pt[0] * s, pt[1] * s)));
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.strokeRect(x, y, w, h);
    }
    const label = String(i + 1);
    const bw = ctx.measureText(label).width + fs * 0.6;
    ctx.fillStyle = "#e11d48";
    ctx.fillRect(x, Math.max(0, y - fs * 1.3), bw, fs * 1.3);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x + fs * 0.3, Math.max(0, y - fs * 1.3) + fs * 0.65);
  });
  return canvas;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGeminiWithRetry(opts, modelOrder, count) {
  const errs = [];
  let retryDelay = null;
  for (let mi = 0; mi < modelOrder.length; mi++) {
    const model = modelOrder[mi];
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        setStatus(
          `Đang gửi ${count} vùng cho Gemini (${model})${attempt > 1 ? ` — thử lại ${attempt}` : ""}…`,
          true,
        );
        return await geminiTranslatePage({ ...opts, model });
      } catch (e) {
        const m = String(e.message || "");
        if (e.retryDelay && /quota|rate limit|exceeded|429/i.test(m)) retryDelay = e.retryDelay;
        if (/high demand|overload|unavailable|temporar|try again|503/i.test(m)) {
          errs.push(`${model}: ${m}`);
          if (attempt < maxAttempts) {
            await sleep(1500 * attempt);
            continue;
          }
          break; // hết lượt -> sang model kế tiếp
        }
        if (/quota|rate limit|exceeded|429/i.test(m)) {
          errs.push(`${model}: ${m}`);
          break; // quota -> thử model khác
        }
        throw e; // lỗi cứng (key sai, model sai…) -> dừng
      }
    }
    if (mi < modelOrder.length - 1) setStatus(`Model ${model} không dùng được, thử model khác…`, true);
  }
  const err = new Error(errs.join(" | ") || "Không model nào dùng được");
  if (retryDelay) err.retryDelay = retryDelay;
  throw err;
}

async function runGeminiTranslate() {
  const page = activePage();
  if (!page || busy) return;
  const key = (els.geminiKey.value || "").trim();
  if (!key) {
    setStatus("Chưa có Gemini API key — mở menu ⋯ để nhập.");
    return;
  }
  if (!page.regions.length) {
    setStatus("Chưa có vùng nào. Bấm “Nhận diện” trước.");
    return;
  }
  const targets = page.regions.filter((r) => !r.style.keep && !(r.text || "").trim());
  if (!targets.length) {
    setStatus("Mọi vùng đã có bản dịch.");
    return;
  }
  setBusy(true);
  try {
    setStatus(`Đang gửi ${targets.length} vùng cho Gemini…`, true);
    const canvas = await buildNumberedImage(page, targets);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const dir = els.transDir.value;
    const opts = {
      apiKey: key,
      imageDataUrl: dataUrl,
      count: targets.length,
      srcLang: dir.startsWith("en") ? "English" : dir.startsWith("vi") ? "Vietnamese" : "auto",
      targetLang: dir.endsWith("vi") ? "Vietnamese" : "English",
      context: state.name || "",
    };
    const modelOrder = [
      els.geminiModel.value,
      ...[...els.geminiModel.options].map((o) => o.value).filter((v) => v !== els.geminiModel.value),
    ];
    const map = await callGeminiWithRetry(opts, modelOrder, targets.length).then((r) => {
      addGeminiUsage(r.usage);
      return r.map;
    });
    let n = 0;
    targets.forEach((r, i) => {
      const entry = map[String(i + 1)] ?? map[i + 1];
      if (!entry) return;
      const src = typeof entry === "string" ? "" : entry.src;
      const vi = typeof entry === "string" ? entry : entry.vi;
      if (src && !(r.source || "").trim()) r.source = src;
      if (vi) {
        r.text = vi;
        n++;
      }
    });
    renderOverlay();
    renderRegionsList();
    renderFields();
    updatePageInfo();
    if (activePage()) updatePageBadge(activePage().id);
    schedulePersist();
    setStatus(`Gemini đã dịch ${n}/${targets.length} vùng. Sửa lại nếu cần.`, false, true);
  } catch (err) {
    console.error(err);
    const m = err.message || "";
    if (err.retryDelay) startGeminiCooldown(parseDuration(err.retryDelay));
    if (/quota|rate limit|exceeded|429/i.test(m)) {
      setStatus("Gemini hết quota/giới hạn — xem đồng hồ đếm ngược trong menu ⋯.");
    } else if (/high demand|overload|unavailable|temporar|try again|503/i.test(m)) {
      setStatus("Model Gemini đang quá tải — thử lại sau ít phút hoặc chọn model khác.");
    } else {
      setStatus(`Lỗi Gemini: ${m}`);
    }
  } finally {
    setBusy(false);
    if (geminiCooldownUntil > Date.now()) els.btnTranslate.disabled = true;
  }
}

/* ---------------- Xoá chữ bằng AI (LaMa inpaint) ---------------- */

async function runInpaint() {
  const page = activePage();
  if (!page || busy) return;
  if (!page.regions.length) {
    setStatus("Chưa có vùng nào. Hãy bấm “Nhận diện” trước.");
    return;
  }
  const { img } = await getPageImage(page);
  setBusy(true);
  try {
    setStatus("Đang tải model xoá chữ (LaMa ~60MB, chỉ lần đầu)…", true);
    const canvas = await inpaintImage(img, page.regions, {
      onProgress: ({ phase, ratio }) => {
        if (phase === "download") setStatus(`Đang tải model xoá chữ… ${Math.round(ratio * 100)}%`, true);
        else if (phase === "cache") setStatus("Model đã có trong cache.", true);
        else if (phase === "inpaint") setStatus(`Đang xoá chữ & tái tạo nền… ${Math.round(ratio * 100)}%`, true);
        else setStatus("Đang khởi tạo model xoá chữ…", true);
      },
    });
    page.cleanBlob = await canvasToBlob(canvas, "image/png");
    dropCleanImage(page.id);
    schedulePersist();
    renderPages();
    renderResult();
    setStatus("Đã xoá chữ bằng AI. Nền sạch được dùng khi xuất & ở khung “Bản dịch”.", false, true);
  } catch (err) {
    console.error(err);
    setStatus(`Lỗi xoá chữ: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

function undoInpaint() {
  const page = activePage();
  if (!page || !page.cleanBlob) return;
  page.cleanBlob = null;
  dropCleanImage(page.id);
  schedulePersist();
  renderPages();
  renderResult();
  setStatus("Đã bỏ nền đã xoá chữ, quay lại ảnh gốc.", false, true);
}

/* ---------------- Export ---------------- */

async function exportPng() {
  const page = activePage();
  if (!page) return;
  const img = await workingImage(page);
  const originalImage = page.cleanBlob ? (await getPageImage(page)).img : null;
  const blob = await exportPageBlob(img, page.regions, {
    type: "image/png",
    skipErase: !!page.cleanBlob,
    originalImage,
  });
  download(blob, `${baseName(state.name || "manga")}_${baseName(page.name)}.translated.png`);
  setStatus("Đã xuất PNG.", false, true);
}

async function exportZip() {
  if (!state.pages.length || busy) return;
  setBusy(true);
  try {
    const zip = new JSZip();
    for (let i = 0; i < state.pages.length; i++) {
      const page = state.pages[i];
      setStatus(`Đang xuất trang ${i + 1}/${state.pages.length}…`, true);
      const img = await workingImage(page);
      const originalImage = page.cleanBlob ? (await getPageImage(page)).img : null;
      const canvas = renderPage(img, page.regions, { skipErase: !!page.cleanBlob, originalImage });
      const blob = await canvasToBlob(canvas, "image/png");
      zip.file(`${String(i + 1).padStart(3, "0")}_${baseName(page.name)}.png`, blob);
      await nextFrame();
    }
    setStatus("Đang nén ZIP…", true);
    const out = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    download(out, `${baseName(state.name || "manga")}.zip`);
    setStatus("Đã xuất ZIP.", false, true);
  } catch (err) {
    console.error(err);
    setStatus(`Lỗi xuất ZIP: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

const baseName = (name = "page") => name.replace(/\.[^.]+$/, "").replace(/[^\w\-]+/g, "_").slice(0, 40) || "page";

function maybeNameProject(name) {
  if (state.name && state.name.trim()) return;
  if (!name) return;
  state.name = name;
  els.projectName.value = name;
}

/* ---------------- Files ---------------- */

async function addFiles(files) {
  await bootReady;
  const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
  if (!list.length) return;
  setBusy(true);
  let firstId = null;
  for (let i = 0; i < list.length; i++) {
    setStatus(`Đang thêm ảnh ${i + 1}/${list.length}…`, true);
    const page = await createPageFromBlob(list[i], list[i].name);
    state.pages.push(page);
    if (!firstId) firstId = page.id;
    await nextFrame();
  }
  if (firstId && (!state.activeId || !state.pages.some((p) => p.id === state.activeId))) {
    state.activeId = firstId;
  }
  setBusy(false);
  await renderActive();
  renderPages();
  maybeNameProject(baseName(list[0].name));
  schedulePersist();
  setStatus(`Đã thêm ${list.length} trang.`, false, true);
}

/* ---------------- Thêm ảnh bằng URL ---------------- */

function extractUrls(text) {
  const matches = String(text).match(/https?:\/\/[^\s"'<>()\\]+/g) || [];
  return [...new Set(matches)];
}

function naturalCompare(a, b) {
  const ax = a.match(/\d+|\D+/g) || [];
  const bx = b.match(/\d+|\D+/g) || [];
  const n = Math.max(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i] || "";
    const y = bx[i] || "";
    const nx = /^\d+$/.test(x) ? parseInt(x, 10) : NaN;
    const ny = /^\d+$/.test(y) ? parseInt(y, 10) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function nameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split("/").filter(Boolean).pop() || "page");
  } catch {
    return "page";
  }
}

// Sắp theo TÊN FILE (1,2,…,10) rồi mới tới URL — tránh việc hash trong URL làm sai thứ tự.
function cmpUrl(a, b) {
  const c = naturalCompare(nameFromUrl(a), nameFromUrl(b));
  return c !== 0 ? c : naturalCompare(a, b);
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|tiff)(\?|#|$)/i;
const looksLikeImageUrl = (url) => IMAGE_EXT.test(url);

function isLikelyContentImage(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (IMAGE_EXT.test(url)) return true;
  return /(blogger\.googleusercontent|blogspot|googleusercontent|imgix|cloudinary|imagekit|githubusercontent)/i.test(url);
}

function normalizeUrl(u, base) {
  if (!u) return null;
  u = u.trim();
  if (!u || u.startsWith("data:") || u.startsWith("blob:")) return null;
  try {
    return new URL(u, base).href;
  } catch {
    return null;
  }
}

// Đọc URL trang chương qua Jina Reader (trả HTML) rồi trích các ảnh nội dung theo đúng thứ tự.
async function scrapeChapter(url) {
  const headers = { "X-Return-Format": "html" };
  const key = (els.urlJinaKey.value || "").trim();
  if (key) headers["Authorization"] = "Bearer " + key;
  const res = await fetch("https://r.jina.ai/" + url, { headers, mode: "cors", credentials: "omit" });
  if (res.status === 429) throw new Error("Jina bị giới hạn tần suất — thêm API key để tăng hạn mức");
  if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const u = normalizeUrl(raw, url);
    if (u && !seen.has(u) && isLikelyContentImage(u)) {
      seen.add(u);
      out.push(u);
    }
  };
  doc.querySelectorAll("img").forEach((img) => {
    add(img.getAttribute("src"));
    add(img.getAttribute("data-src"));
    add(img.getAttribute("data-lazy-src"));
    add(img.getAttribute("data-original"));
    const ss = img.getAttribute("srcset");
    if (ss) ss.split(",").forEach((part) => add(part.trim().split(/\s+/)[0]));
  });
  doc.querySelectorAll("source[srcset]").forEach((s) => {
    (s.getAttribute("srcset") || "").split(",").forEach((part) => add(part.trim().split(/\s+/)[0]));
  });
  doc.querySelectorAll("a[href]").forEach((a) => {
    const h = a.getAttribute("href");
    if (h && IMAGE_EXT.test(h)) add(h);
  });
  return out;
}

async function fetchImageBlob(url, useProxy) {
  const direct = async (u) => {
    const res = await fetch(u, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (blob.size < 32) throw new Error("File rỗng");
    return blob;
  };
  try {
    return await direct(url);
  } catch (err) {
    if (!useProxy) throw err;
    const proxied = `https://images.weserv.nl/?url=${encodeURIComponent(url.replace(/^https?:\/\//, ""))}`;
    return await direct(proxied);
  }
}

function openUrlModal() {
  els.urlStatus.textContent = "";
  els.urlStatus.classList.remove("error");
  if (!els.urlJinaKey.value) {
    try {
      els.urlJinaKey.value = localStorage.getItem("mt-jina-key") || "";
    } catch {
      /* ignore */
    }
  }
  els.urlModal.classList.remove("hidden");
  els.urlInput.focus();
}

function closeUrlModal() {
  els.urlModal.classList.add("hidden");
}

function persistJinaKey() {
  const key = (els.urlJinaKey.value || "").trim();
  if (!key) return;
  try {
    localStorage.setItem("mt-jina-key", key);
  } catch {
    /* ignore */
  }
}

// Chỉ trích danh sách ảnh (không tải). Dùng chung cho cả "Lấy URL ảnh" và "Tải ảnh".
async function collectImageEntries(entries) {
  const images = [];
  const failed = [];
  for (const url of entries) {
    if (looksLikeImageUrl(url) || !els.urlJina.checked) {
      images.push({ url, fromChapter: false });
      continue;
    }
    els.urlStatus.textContent = `Đang đọc trang (Jina)…\n${url}`;
    try {
      const found = await scrapeChapter(url);
      if (!found.length) failed.push(`${url} — không tìm thấy ảnh truyện`);
      found.forEach((iu) => images.push({ url: iu, fromChapter: true }));
    } catch (err) {
      failed.push(`${url} — ${err.message}`);
    }
    await nextFrame();
  }
  return { images, failed };
}

async function extractImageUrls() {
  await bootReady;
  const entries = extractUrls(els.urlInput.value).sort(cmpUrl);
  if (!entries.length) {
    els.urlStatus.textContent = "Không tìm thấy URL hợp lệ.";
    els.urlStatus.classList.add("error");
    return;
  }
  persistJinaKey();
  els.urlFetch.disabled = true;
  els.urlExtract.disabled = true;
  els.urlStatus.classList.remove("error");
  setBusy(true);
  try {
    const { images, failed } = await collectImageEntries(entries);
    const urls = [...new Set(images.map((i) => i.url))].sort(cmpUrl);
    els.urlInput.value = urls.join("\n");
    els.urlStatus.textContent =
      `Đã lấy ${urls.length} URL ảnh. Bấm “Tải ảnh” để tải về.` + (failed.length ? `\nLỗi: ${failed.join("; ")}` : "");
    setStatus(`Đã lấy ${urls.length} URL ảnh.`, false, true);
  } finally {
    els.urlFetch.disabled = false;
    els.urlExtract.disabled = false;
    setBusy(false);
  }
}

async function addFromUrls() {
  await bootReady;
  const entries = extractUrls(els.urlInput.value).sort(cmpUrl);
  if (!entries.length) {
    els.urlStatus.textContent = "Không tìm thấy URL hợp lệ.";
    els.urlStatus.classList.add("error");
    return;
  }
  persistJinaKey();

  els.urlFetch.disabled = true;
  els.urlExtract.disabled = true;
  els.urlStatus.classList.remove("error");
  setBusy(true);
  // 1) Gom danh sách ảnh cần tải (nếu là URL trang thì đọc bằng Jina)
  const { images, failed } = await collectImageEntries(entries);

  // 2) Tải từng ảnh (song song có giới hạn, vẫn giữ đúng thứ tự)
  const slots = new Array(images.length).fill(null);
  let cursor = 0;
  let done = 0;
  const CONCURRENCY = 4;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= images.length) return;
      const item = images[i];
      try {
        const blob = await fetchImageBlob(item.url, els.urlProxy.checked);
        const page = await createPageFromBlob(blob, nameFromUrl(item.url), item.url);
        if (!(item.fromChapter && Math.max(page.width, page.height) < 260)) slots[i] = page;
      } catch (err) {
        failed.push(`${item.url} — ${err.message}`);
      }
      done++;
      els.urlStatus.textContent = `Đang tải ảnh ${done}/${images.length}…`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, images.length || 1) }, worker));

  let firstId = null;
  let ok = 0;
  for (const page of slots) {
    if (!page) continue;
    state.pages.push(page);
    if (!firstId) firstId = page.id;
    ok++;
  }

  if (firstId && (!state.activeId || !state.pages.some((p) => p.id === state.activeId))) {
    state.activeId = firstId;
  }
  const chap = entries.find((u) => !looksLikeImageUrl(u));
  maybeNameProject(chap ? baseName(nameFromUrl(chap)) : "");
  setBusy(false);
  els.urlFetch.disabled = false;
  els.urlExtract.disabled = false;
  await renderActive();
  renderPages();
  schedulePersist();
  if (!failed.length) {
    setStatus(`Đã thêm ${ok} trang.`, false, true);
    closeUrlModal();
  } else {
    els.urlStatus.textContent = `Xong ${ok} trang. Lỗi:\n` + failed.join("\n");
    els.urlStatus.classList.add("error");
    setStatus(`Đã thêm ${ok} trang (một số lỗi).`);
  }
}

async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copyPageUrl(id) {
  const page = state.pages.find((p) => p.id === id);
  if (!page?.sourceUrl) return;
  const ok = await copyText(page.sourceUrl);
  setStatus(ok ? "Đã sao chép URL." : "Không sao chép được (thiếu quyền).", false, ok);
}

function removePage(id) {
  const page = state.pages.find((p) => p.id === id);
  if (page && page.regions.some((r) => r.text)) {
    if (!confirm("Trang này có bản dịch chưa xuất. Xoá?")) return;
  }
  state.pages = state.pages.filter((p) => p.id !== id);
  dropPageImage(id);
  dropCleanImage(id);
  if (state.activeId === id) state.activeId = state.pages[0]?.id || null;
  if (selectedId && !activePage()?.regions.some((r) => r.id === selectedId)) selectedId = null;
  renderActive();
  renderPages();
  schedulePersist();
}

/* ---------------- Projects ---------------- */

async function saveProject() {
  setStatus("Đang lưu…", true);
  try {
    await persist(state);
    setStatus("Đã lưu vào trình duyệt.", false, true);
  } catch (e) {
    setStatus(`Lỗi lưu: ${e.message}`);
  }
}

function newProject() {
  if (state.pages.length) {
    const msg = projectDirty
      ? "Project hiện tại CÓ THAY ĐỔI CHƯA XUẤT RA FILE.\nTạo project mới sẽ làm mất các thay đổi này.\n\nBấm Cancel rồi dùng “Xuất project” nếu muốn giữ lại. Vẫn tạo mới?"
      : "Tạo project mới? (Project hiện tại đã xuất, vẫn có thể Mở lại sau.)";
    if (!confirm(msg)) return;
  }
  for (const p of state.pages) {
    dropPageImage(p.id);
    dropCleanImage(p.id);
  }
  state = createState();
  selectedId = null;
  els.projectName.value = "";
  els.threshold.value = state.settings.threshold ?? 0.4;
  els.thresholdVal.textContent = Number(els.threshold.value).toFixed(2);
  els.ocrLang.value = state.settings.ocrLang || "jpn";
  els.transDir.value = state.settings.transDir || "en-vi";
  els.ocrModeRegion.checked = state.settings.ocrMode !== "page";
  els.showBoxes.checked = true;
  els.compareToggle.checked = false;
  els.paneResult.classList.add("hidden");
  els.panes.classList.remove("comparing");
  initTransUI();
  renderGlobalFields();
  renderPages();
  renderActive();
  schedulePersist();
  projectDirty = false;
  setStatus("Đã tạo project mới. Thêm ảnh để bắt đầu.", false, true);
}

async function exportProjectFile() {
  if (!state.pages.length) return;
  setBusy(true);
  setStatus("Đang đóng gói project…", true);
  try {
    const blob = await exportProject(state);
    download(blob, `${baseName(state.name || "project")}.mtproj`);
    setStatus("Đã xuất project.", false, true);
    projectDirty = false;
  } catch (e) {
    setStatus(`Lỗi: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

async function loadProjectFile(file) {
  await bootReady;
  setBusy(true);
  setStatus("Đang mở project…", true);
  try {
    const next = await importProject(file);
    for (const p of state.pages) {
      dropPageImage(p.id);
      dropCleanImage(p.id);
    }
    state = next;
    selectedId = null;
    if (!state.settings.style) state.settings.style = defaultStyle(24);
    els.projectName.value = state.name || "";
    renderGlobalFields();
    await renderActive();
    renderPages();
    await persist(state);
    projectDirty = false;
    setStatus(`Đã mở ${state.pages.length} trang.`, false, true);
  } catch (e) {
    console.error(e);
    setStatus(`Lỗi mở project: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

/* ---------------- UI wiring ---------------- */

function wire() {
  if (els.appVersion) els.appVersion.textContent = `v${APP_VERSION}`;
  if (els.menuVersion) els.menuVersion.textContent = `Manga Translator v${APP_VERSION}`;
  $("btnAddImages").addEventListener("click", () => els.fileInput.click());
  $("btnAddUrl").addEventListener("click", openUrlModal);
  els.urlCancel.addEventListener("click", closeUrlModal);
  els.urlFetch.addEventListener("click", addFromUrls);
  els.urlExtract.addEventListener("click", extractImageUrls);
  els.urlModal.addEventListener("click", (e) => {
    if (e.target === els.urlModal) closeUrlModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!els.urlModal.classList.contains("hidden")) closeUrlModal();
    els.topMenu.classList.add("hidden");
  });
  $("btnDetect").addEventListener("click", runDetect);
  $("btnOcr").addEventListener("click", runOcr);
  $("btnInpaint").addEventListener("click", runInpaint);
  $("btnInpaintUndo").addEventListener("click", undoInpaint);
  $("btnTranslate").addEventListener("click", runTranslate);
  $("btnSave").addEventListener("click", saveProject);
  $("btnNewProject").addEventListener("click", newProject);  $("btnOpen").addEventListener("click", () => els.projectInput.click());
  $("btnExportProject").addEventListener("click", exportProjectFile);
  $("btnExportPng").addEventListener("click", exportPng);
  $("btnExportZip").addEventListener("click", exportZip);
  $("btnAddRegion").addEventListener("click", () => {
    drawMode = !drawMode;
    $("btnAddRegion").classList.toggle("primary", drawMode);
    setStatus(drawMode ? "Kéo trên ảnh để vẽ vùng dịch mới." : "Sẵn sàng");
  });
  els.btnTheme.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });

  const positionMenu = () => {
    const r = els.btnMenu.getBoundingClientRect();
    els.topMenu.style.top = `${r.bottom + 6}px`;
    els.topMenu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    els.topMenu.style.left = "auto";
  };
  const closeMenu = () => els.topMenu.classList.add("hidden");
  els.btnMenu.addEventListener("click", (e) => {
    e.stopPropagation();
    if (els.topMenu.classList.contains("hidden")) {
      positionMenu();
      els.topMenu.classList.remove("hidden");
    } else {
      closeMenu();
    }
  });
  els.topMenu.addEventListener("click", (e) => {
    if (e.target.closest("button")) closeMenu();
  });
  document.addEventListener("click", (e) => {
    if (!els.topMenu.classList.contains("hidden") && !els.topMenu.contains(e.target)) closeMenu();
  });

  els.fileInput.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    els.fileInput.value = "";
    addFiles(files);
  });
  els.projectInput.addEventListener("change", (e) => {
    if (e.target.files[0]) loadProjectFile(e.target.files[0]);
    els.projectInput.value = "";
  });

  els.threshold.addEventListener("input", () => {
    els.thresholdVal.textContent = Number(els.threshold.value).toFixed(2);
    state.settings.threshold = Number(els.threshold.value);
    persistSoon();
  });
  els.ocrLang.addEventListener("change", () => {
    state.settings.ocrLang = els.ocrLang.value;
    persistSoon();
  });
  els.projectName.addEventListener("input", () => {
    state.name = els.projectName.value;
    persistSoon();
  });
  els.transDir.addEventListener("change", () => {
    state.settings.transDir = els.transDir.value;
    const src = els.transDir.value.split("-")[0];
    const map = { en: "eng", vi: "vie" };
    if (map[src] && els.ocrLang.value !== map[src]) {
      els.ocrLang.value = map[src];
      state.settings.ocrLang = map[src];
    }
    persistSoon();
  });
  els.ocrModeRegion.addEventListener("change", () => {
    state.settings.ocrMode = els.ocrModeRegion.checked ? "region" : "page";
    persistSoon();
  });
  els.transProvider.addEventListener("change", () => {
    state.settings.transProvider = els.transProvider.value;
    updateTransProviderUI();
    if (state.settings.transProvider === "gemini") refreshGeminiModels();
    persistSoon();
  });
  els.geminiModel.addEventListener("change", () => {
    state.settings.geminiModel = els.geminiModel.value;
    applySuggestedLimits(els.geminiModel.value);
    persistSoon();
  });
  els.geminiKey.addEventListener("input", () => {
    try {
      localStorage.setItem("mt-gemini-key", els.geminiKey.value);
    } catch {
      /* ignore */
    }
  });
  els.geminiKey.addEventListener("change", () => refreshGeminiModels());
  const saveLimits = () => {
    state.settings.geminiLimits = {
      rpm: Number(els.limRpm.value) || 5,
      tpm: Number(els.limTpm.value) || 250000,
      rpd: Number(els.limRpd.value) || 20,
    };
    updateGeminiUsageUI();
    persistSoon();
  };
  els.limRpm.addEventListener("change", saveLimits);
  els.limTpm.addEventListener("change", saveLimits);
  els.limRpd.addEventListener("change", saveLimits);
  els.showBoxes.addEventListener("change", () => {
    state.display.showBoxes = els.showBoxes.checked;
    renderOverlay();
  });

  els.compareToggle.addEventListener("change", () => {
    state.display.compare = els.compareToggle.checked;
    els.paneResult.classList.toggle("hidden", !state.display.compare);
    els.panes.classList.toggle("comparing", state.display.compare);
    renderOverlay();
    if (state.display.compare) {
      applyScale();
      renderResult();
    }
  });
  setupScrollSync();

  $("zoomIn").addEventListener("click", () => {
    state.display.fit = false;
    state.display.scale = clamp(state.display.scale * 1.2, 0.05, 6);
    applyScale();
    renderOverlay();
  });
  $("zoomOut").addEventListener("click", () => {
    state.display.fit = false;
    state.display.scale = clamp(state.display.scale / 1.2, 0.05, 6);
    applyScale();
    renderOverlay();
  });
  $("zoomFit").addEventListener("click", () => {
    state.display.fit = true;
    applyScale();
    renderOverlay();
  });

  window.addEventListener("resize", debounce(() => {
    if (state.display.fit) {
      applyScale();
      renderOverlay();
    }
  }, 120));

  // drag & drop
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    els.dropzone.classList.add("active");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropzone.classList.remove("active");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove("active");
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  window.addEventListener("beforeunload", () => {
    try {
      navigator.sendBeacon?.("");
    } catch {}
  });
}

/* ---------------- Boot ---------------- */

let syncingScroll = false;
function setupScrollSync() {
  const a = els.stageScroll;
  const b = els.resultScroll;
  const link = (src, dst) => () => {
    if (syncingScroll || els.paneResult.classList.contains("hidden")) return;
    syncingScroll = true;
    const maxSx = Math.max(1, src.scrollWidth - src.clientWidth);
    const maxSy = Math.max(1, src.scrollHeight - src.clientHeight);
    dst.scrollLeft = (src.scrollLeft / maxSx) * Math.max(0, dst.scrollWidth - dst.clientWidth);
    dst.scrollTop = (src.scrollTop / maxSy) * Math.max(0, dst.scrollHeight - dst.clientHeight);
    requestAnimationFrame(() => (syncingScroll = false));
  };
  a.addEventListener("scroll", link(a, b));
  b.addEventListener("scroll", link(b, a));
}

async function loadAppFonts() {
  if (!document.fonts?.load) return;
  const names = [...new Set(FONT_FAMILIES.map((f) => fontFamilyName(f.value)))];
  const jobs = [];
  for (const name of names) {
    jobs.push(document.fonts.load(`400 24px "${name}"`).catch(() => {}));
    jobs.push(document.fonts.load(`700 24px "${name}"`).catch(() => {}));
  }
  await Promise.all(jobs);
  if (document.fonts.ready) await document.fonts.ready;
}

async function boot() {
  try {
    applyTheme(document.documentElement.dataset.theme || "light");
    wire();
    restoreGeminiCooldown();
    setInterval(updateGeminiUsageUI, 5000);
    await loadAppFonts();
    const restored = await restore().catch((e) => {
      console.warn(e);
      return null;
    });
    if (restored) {
      state = restored;
      els.threshold.value = state.settings.threshold ?? 0.4;
      els.thresholdVal.textContent = Number(els.threshold.value).toFixed(2);
      els.ocrLang.value = state.settings.ocrLang || "jpn";
      els.transDir.value = state.settings.transDir || "en-vi";
      els.ocrModeRegion.checked = state.settings.ocrMode !== "page";
      initTransUI();
      els.showBoxes.checked = state.display.showBoxes !== false;
      els.compareToggle.checked = !!state.display.compare;
      els.paneResult.classList.toggle("hidden", !state.display.compare);
      els.panes.classList.toggle("comparing", !!state.display.compare);
      selectedId = null;
      if (!state.settings.style) state.settings.style = defaultStyle(24);
      els.projectName.value = state.name || "";
      renderGlobalFields();
      await renderActive();
      renderPages();
      setStatus(`Đã khôi phục ${state.pages.length} trang từ lần trước.`, false, true);
    } else {
      if (!state.settings.style) state.settings.style = defaultStyle(24);
      initTransUI();
      renderGlobalFields();
      renderActive();
      renderPages();
    }
  } finally {
    bootDone();
  }
}

boot();
