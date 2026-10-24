// Same-origin server for the live browser acceptance: it serves the built UI (frontend/dist) and
// forwards /api/* to a running backend, like the production image does. It keeps the Host,
// Origin and cookie headers exactly as the browser sent them, so the backend's own Origin check
// (same origin, no TRUSTED_ORIGINS needed) and its cookies work unchanged. Nothing is logged:
// no URL, header or body is written anywhere.
//
//   LIVE_BACKEND=http://127.0.0.1:58090 LIVE_PORT=5199 node live/serve.mjs
//
// Local only: the backend must be a loopback http URL, the server listens on 127.0.0.1, requests
// must name a loopback Host, and a backend redirect may not leave the browser's origin.
import { createReadStream } from "node:fs";
import http from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isLoopbackHost, parseLoopbackUrl, redirectAllowed, resolveStatic } from "./core.mjs";

let backend;
try {
  backend = parseLoopbackUrl(process.env.LIVE_BACKEND ?? "http://127.0.0.1:58090", "LIVE_BACKEND");
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const port = Number(process.env.LIVE_PORT ?? 5199);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("LIVE_PORT must be a port number");
  process.exit(2);
}
// LIVE_DIST exists for the tooling tests; normally the UI built in frontend/dist is served.
const dist = resolve(process.env.LIVE_DIST ?? fileURLToPath(new URL("../../frontend/dist", import.meta.url)));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function reply(res, status, text) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function proxy(req, res, requestOrigin) {
  const upstream = http.request(
    {
      host: backend.hostname,
      port: backend.port,
      method: req.method,
      path: req.url,
      headers: req.headers, // Host, Origin and Cookie are passed through untouched
    },
    (answer) => {
      const status = answer.statusCode ?? 502;
      if (status >= 300 && status < 400 && !redirectAllowed(answer.headers.location, requestOrigin)) {
        answer.resume();
        reply(res, 502, "redirect outside the local origin blocked");
        return;
      }
      res.writeHead(status, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on("error", () => reply(res, 502, "backend unreachable"));
  req.pipe(upstream);
}

function serveFile(res, pathname) {
  const target = resolveStatic(dist, pathname);
  if (target.kind === "bad-request") return reply(res, 400, "bad request");
  if (target.kind === "not-found") return reply(res, 404, "not found");
  const file = target.kind === "file" ? target.file : resolve(dist, "index.html");
  const stream = createReadStream(file);
  stream.on("error", () => reply(res, 404, "not found"));
  stream.once("open", () => {
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    stream.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  try {
    // DNS-rebinding guard: only a loopback name may be used to reach this server.
    const host = req.headers.host ?? "";
    let requestOrigin;
    try {
      requestOrigin = new URL(`http://${host}`).origin;
    } catch {
      return reply(res, 400, "bad host");
    }
    if (!isLoopbackHost(new URL(requestOrigin).hostname)) return reply(res, 421, "loopback only");

    const raw = req.url ?? "/";
    if (!raw.startsWith("/")) return reply(res, 400, "bad request");
    const pathname = raw.split("?")[0];
    if (pathname === "/api" || pathname.startsWith("/api/")) return proxy(req, res, requestOrigin);
    return serveFile(res, pathname);
  } catch {
    return reply(res, 500, "error");
  }
});
server.on("clientError", (_error, socket) => socket.destroy());

server.listen(port, "127.0.0.1", () => {
  console.log(`live UI on http://127.0.0.1:${port} (backend ${backend.origin})`);
});
