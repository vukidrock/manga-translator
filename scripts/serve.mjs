import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 5173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".onnx": "application/octet-stream",
};

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const urlPath = decodeURIComponent(parsed.pathname);

  // Proxy ảnh: /proxy?url=<encoded> -> server tải hộ (tránh CORS/kiểm tra hotlink)
  if (urlPath === "/proxy") {
    const target = parsed.searchParams.get("url");
    if (!target || !/^https?:\/\//i.test(target)) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("URL không hợp lệ");
      return;
    }
    try {
      let origin = "";
      try {
        origin = new URL(target).origin + "/";
      } catch {
        /* ignore */
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      let upstream;
      try {
        upstream = await fetch(target, {
          redirect: "follow",
          signal: ctrl.signal,
          headers: {
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
            accept: "image/avif,image/webp,image/*,*/*;q=0.8",
            referer: origin,
          },
        });
      } finally {
        clearTimeout(timer);
      }
      if (!upstream.ok) {
        res.writeHead(upstream.status, { "access-control-allow-origin": "*" }).end(`Upstream ${upstream.status}`);
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, {
        "content-type": upstream.headers.get("content-type") || "application/octet-stream",
        "content-length": buf.length,
        "cache-control": "public, max-age=3600",
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      });
      res.end(buf);
    } catch (err) {
      res.writeHead(502, { "access-control-allow-origin": "*" }).end(`Proxy lỗi: ${err.message}`);
    }
    return;
  }

  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(ROOT, rel);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-cache",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "cross-origin",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Manga Translator đang chạy tại http://localhost:${PORT}`);
});
