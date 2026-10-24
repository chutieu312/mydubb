// Same-origin server for the live browser acceptance: it serves the built UI (frontend/dist) and
// forwards /api/* to a running backend, like the production image does. It keeps the Host,
// Origin and cookie headers exactly as the browser sent them, so the backend's own Origin check
// (same origin, no TRUSTED_ORIGINS needed) and its cookies work unchanged. Nothing is logged:
// no URL, header or body is written anywhere.
//
//   LIVE_BACKEND=http://127.0.0.1:58090 LIVE_PORT=5199 node live/serve.mjs
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backend = new URL(process.env.LIVE_BACKEND ?? "http://127.0.0.1:58090");
const port = Number(process.env.LIVE_PORT ?? 5199);
const dist = resolve(fileURLToPath(new URL("../../frontend/dist", import.meta.url)));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    const upstream = http.request(
      {
        host: backend.hostname,
        port: backend.port,
        method: req.method,
        path: req.url,
        headers: req.headers, // Host, Origin and Cookie are passed through untouched
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("backend unreachable");
    });
    req.pipe(upstream);
    return;
  }

  const requested = normalize(join(dist, decodeURIComponent(url.pathname)));
  const file =
    requested.startsWith(dist) && existsSync(requested) && statSync(requested).isFile()
      ? requested
      : join(dist, "index.html"); // the UI has a single page; unknown paths fall back to it
  res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`live UI on http://127.0.0.1:${port} (backend ${backend.origin})`);
});
