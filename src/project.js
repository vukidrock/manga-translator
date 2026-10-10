import { uid, loadImage } from "./util.js";
import { makeThumb } from "./render.js";
import { defaultStyle } from "./regions.js";

const DB_NAME = "manga-translator";
const DB_VERSION = 1;
const STORE_PAGES = "pages";
const STORE_META = "meta";

export function createState() {
  return {
    name: "",
    pages: [],
    activeId: null,
    glossary: [],
    tm: [],
    settings: { ocrLang: "jpn", ocrMode: "region", threshold: 0.4, transDir: "en-vi", transProvider: "offline", geminiModel: "gemini-3.1-flash-lite", geminiLimits: { rpm: 15, tpm: 250000, rpd: 500 }, useTM: true, style: defaultStyle(24) },
    display: { scale: 1, fit: true, showBoxes: true, compare: false },
  };
}

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PAGES)) db.createObjectStore(STORE_PAGES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function persist(state) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE_PAGES, STORE_META], "readwrite");
    const pages = t.objectStore(STORE_PAGES);
    const meta = t.objectStore(STORE_META);
    const keysReq = pages.getAllKeys();
    keysReq.onsuccess = () => {
      const ids = new Set(state.pages.map((p) => p.id));
      for (const key of keysReq.result) if (!ids.has(key)) pages.delete(key);
      for (const page of state.pages) {
        pages.put({
          id: page.id,
          name: page.name,
          width: page.width,
          height: page.height,
          mime: page.mime,
          thumb: page.thumb,
          imageBlob: page.imageBlob,
          cleanBlob: page.cleanBlob || null,
          sourceUrl: page.sourceUrl || null,
          brushMask: page.brushMask || null,
          regions: page.regions,
        });
      }
      meta.put({ name: state.name || "", order: state.pages.map((p) => p.id), activeId: state.activeId, settings: state.settings, glossary: state.glossary || [], tm: state.tm || [] }, "state");
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function restore() {
  const db = await openDB();
  const pages = await reqToPromise(tx(db, STORE_PAGES, "readonly").getAll());
  let meta = null;
  try {
    meta = await reqToPromise(tx(db, STORE_META, "readonly").get("state"));
  } catch {
    meta = null;
  }
  const hasGlossary = (meta?.glossary || []).length || (meta?.tm || []).length || !!meta?.name;
  if (!pages.length && !hasGlossary) return null;
  const state = createState();
  const byId = new Map(pages.map((p) => [p.id, p]));
  const order = meta?.order || pages.map((p) => p.id);
  state.pages = order.filter((id) => byId.has(id)).map((id) => byId.get(id));
  for (const p of pages) if (!byId.has(p.id)) state.pages.push(p);
  state.pages.forEach((p) => {
    p.regions = p.regions || [];
  });
  state.activeId = meta?.activeId && byId.has(meta.activeId) ? meta.activeId : state.pages[0]?.id || null;
  state.name = meta?.name || "";
  state.glossary = meta?.glossary || [];
  state.tm = meta?.tm || [];
  if (meta?.settings) Object.assign(state.settings, meta.settings);
  return state;
}

export async function clearAll() {
  const db = await openDB();
  tx(db, STORE_PAGES, "readwrite").clear();
  tx(db, STORE_META, "readwrite").clear();
}

export async function createPageFromBlob(blob, name, sourceUrl = null) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    return {
      id: uid("p"),
      name: name || "page",
      width: img.naturalWidth,
      height: img.naturalHeight,
      mime: blob.type || "image/png",
      imageBlob: blob,
      cleanBlob: null,
      sourceUrl,
      brushMask: null,
      thumb: makeThumb(img),
      regions: [],
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const zipExt = (mime) => (mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png");

export async function exportProject(state) {
  const zip = new JSZip();
  const pages = [];
  for (const page of state.pages) {
    const ext = zipExt(page.mime || "image/png");
    const imageFile = `images/${page.id}.${ext}`;
    zip.file(imageFile, page.imageBlob);
    let cleanFile = null;
    if (page.cleanBlob) {
      cleanFile = `images/${page.id}.clean.png`;
      zip.file(cleanFile, page.cleanBlob);
    }
    pages.push({
      id: page.id,
      name: page.name,
      width: page.width,
      height: page.height,
      mime: page.mime,
      imageFile,
      cleanFile,
      sourceUrl: page.sourceUrl || null,
      brushMask: page.brushMask || null,
      regions: page.regions,
    });
  }
  zip.file(
    "project.json",
    JSON.stringify({ version: 1, app: "manga-translator", name: state.name || "", activeId: state.activeId, settings: state.settings, glossary: state.glossary || [], tm: state.tm || [], pages }, null, 2),
  );
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

export async function importProject(file) {
  const zip = await JSZip.loadAsync(file);
  const metaFile = zip.file("project.json");
  if (!metaFile) throw new Error("File project không hợp lệ (thiếu project.json)");
  const data = JSON.parse(await metaFile.async("string"));
  const state = createState();
  state.name = data.name || "";
  state.glossary = data.glossary || [];
  state.tm = data.tm || [];
  Object.assign(state.settings, data.settings || {});
  for (const p of data.pages || []) {
    const imgEntry = zip.file(p.imageFile);
    if (!imgEntry) continue;
    const blob = await imgEntry.async("blob");
    const typed = blob.slice(0, blob.size, p.mime || blob.type || "image/png");
    let cleanBlob = null;
    if (p.cleanFile) {
      const cleanEntry = zip.file(p.cleanFile);
      if (cleanEntry) cleanBlob = await cleanEntry.async("blob");
    }
    state.pages.push({
      id: p.id || uid("p"),
      name: p.name || "page",
      width: p.width,
      height: p.height,
      mime: p.mime || typed.type,
      imageBlob: typed,
      cleanBlob,
      sourceUrl: p.sourceUrl || null,
      brushMask: p.brushMask || null,
      thumb: null,
      regions: (p.regions || []).map((r) => ({ ...r })),
    });
  }
  state.activeId = state.pages.find((p) => p.id === data.activeId)?.id || state.pages[0]?.id || null;
  return state;
}
