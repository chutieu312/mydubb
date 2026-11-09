// Local fixture server for the Sync prototype's browser tests (never a real site). Chromium maps
// site.test, player.test and blocked.test to it (--host-resolver-rules), so the pages and the
// cross-origin player frame really are different origins. The media is a synthetic silent WAV
// served with HTTP Range support; with ?slow=1 a seek past its first 20 s waits for data.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const SAMPLE_RATE = 8000; // 8 kHz, 8-bit mono: 8,000 bytes per second of media

export function silentWav(seconds: number): Buffer {
  const samples = SAMPLE_RATE * seconds;
  const buffer = Buffer.alloc(44 + samples, 128);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(samples, 40);
  return buffer;
}

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px sans-serif;margin:16px} video{background:#222;display:block;margin:8px 0}</style></head>
<body><h1>${title} (synthetic fixture)</h1>${body}</body></html>`;

// The page's own helpers for the tests (main world). A "site player" option puts its own speed back
// on play, as some players do.
const helpers = `<script>
const qs = new URLSearchParams(location.search);
window.fixture = {
  videos: () => [...document.querySelectorAll("video")],
  state(i = 0) { const v = this.videos()[i]; return v && { paused: v.paused, t: v.currentTime, rate: v.playbackRate, muted: v.muted, src: v.currentSrc }; },
  /** Content switch in a single-page app: new URL path and a new player element. */
  next() {
    history.pushState({}, "", location.pathname.replace(/\\d+$/, (n) => String(Number(n) + 1)));
    const old = document.getElementById("main");
    const v = document.createElement("video");
    v.id = "main"; v.width = 640; v.height = 360; v.preload = "auto"; v.src = "/media/a.wav?seconds=120&v=2";
    old.replaceWith(v);
  },
  /** The same element gets another video. */
  swapSource() { document.getElementById("main").src = "/media/a.wav?seconds=120&v=3"; },
  /** Only the query changes (e.g. a ?t= position in the URL). */
  query() { history.replaceState({}, "", location.pathname + "?t=5"); },
};
// A site player that keeps its own sound setting and puts it back when muted from outside.
if (qs.get("keepSound")) {
  for (const v of document.querySelectorAll("video")) v.addEventListener("volumechange", () => { if (v.muted) v.muted = false; });
}
if (qs.get("resetRateOnPlay")) {
  for (const v of document.querySelectorAll("video")) v.addEventListener("play", () => { if (v.playbackRate !== 1) v.playbackRate = 1; });
}
</script>`;

function media(seconds: number, slow = false) {
  return `/media/a.wav?seconds=${seconds}${slow ? "&slow=1" : ""}`;
}

function html(url: URL, port: number): string | null {
  const seconds = Number(url.searchParams.get("seconds") ?? "120");
  const main = `<video id="main" width="640" height="360" preload="auto" src="${media(seconds, url.searchParams.get("slow") === "1")}"></video>`;
  switch (url.pathname) {
    case "/direct.html":
      return page("Direct video", main + helpers);
    case "/multi/1":
    case "/multi/2":
      // A main player, a second ordinary video (another lesson's, with sound, paused) and a small
      // muted looping preview, as on pages with teasers.
      return page(
        "Main video, another video and a preview",
        `${main}<video id="other" width="320" height="180" preload="auto" src="${media(60)}"></video>` +
          `<video id="preview" width="200" height="112" muted loop autoplay src="${media(20)}"></video>${helpers}`,
      );
    case "/main-and-preview.html":
      return page(
        "Main video and preview",
        `${main}<video id="preview" width="200" height="112" muted loop autoplay src="${media(20)}"></video>${helpers}`,
      );
    case "/background.html":
      // Only a muted looping background video: nothing to dub.
      return page("Background video", `<video id="preview" width="640" height="200" muted loop autoplay src="${media(20)}"></video>${helpers}`);
    case "/player.html":
      return page("Player frame", main + helpers);
    case "/embed.html":
      return page(
        "Embedded player",
        `<iframe id="frame" width="680" height="420" src="http://player.test:${port}/player.html${url.search}"></iframe>`,
      );
    case "/embed-preview.html":
      // A preview video in the page and the real player in a cross-origin frame.
      return page(
        "Preview and embedded player",
        `<video id="preview" width="200" height="112" muted loop autoplay src="${media(20)}"></video>` +
          `<iframe id="frame" width="680" height="420" src="http://player.test:${port}/player.html"></iframe>${helpers}`,
      );
    case "/embed-blocked.html":
      // A preview video in the page and a large frame the extension may not access.
      return page(
        "Preview and inaccessible frame",
        `<video id="preview" width="200" height="112" muted loop autoplay src="${media(20)}"></video>` +
          `<iframe id="frame" width="680" height="420" src="http://blocked.test:${port}/player.html"></iframe>${helpers}`,
      );
    case "/embed-loom.html": {
      // A local host page with the real Loom embed player (only for the opt-in live probe).
      const id = url.searchParams.get("id") ?? "";
      if (!/^[0-9a-f]{32}$/.test(id)) return null;
      return page("Loom embed", `<iframe id="frame" width="720" height="405" allowfullscreen src="https://www.loom.com/embed/${id}"></iframe>`);
    }
    case "/other.html":
      return page("Another page", "<p>No video here.</p>");
    default:
      return null;
  }
}

function serveMedia(req: IncomingMessage, res: ServerResponse, url: URL, firstRequest: Map<string, number>): void {
  const wav = silentWav(Number(url.searchParams.get("seconds") ?? "120"));
  // ?slow=1: a network that stalls. The first PREFIX_SECONDS of media come at once; every byte after
  // them, on whatever request, only REST_AFTER_MS after the media was first asked for. A seek past
  // the prefix before then really waits for data.
  const slow = url.searchParams.get("slow") === "1";
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
  res.writeHead(range ? 206 : 200, {
    "content-type": "audio/wav",
    "accept-ranges": "bytes",
    "content-length": String(end - start + 1),
    ...(range ? { "content-range": `bytes ${start}-${end}/${wav.length}` } : {}),
    "cache-control": "no-store",
  });
  if (!slow) return void res.end(wav.subarray(start, end + 1));
  if (!firstRequest.has(url.search)) firstRequest.set(url.search, Date.now());
  const prefixEnd = Math.min(end + 1, Math.max(start, 44 + PREFIX_SECONDS * SAMPLE_RATE));
  if (prefixEnd > start) res.write(wav.subarray(start, prefixEnd));
  const timer = setTimeout(() => res.end(wav.subarray(prefixEnd, end + 1)), Math.max(0, firstRequest.get(url.search)! + REST_AFTER_MS - Date.now()));
  res.on("close", () => clearTimeout(timer));
}

// Chrome reads about 256 KB of this WAV before it has its metadata.
const PREFIX_SECONDS = 40;
const REST_AFTER_MS = 9000;

export async function startFixtureServer(): Promise<{ port: number; close(): Promise<void> }> {
  let port = 0;
  // Per server (one per test): when each slow media was first asked for.
  const firstRequest = new Map<string, number>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/media/a.wav") return serveMedia(req, res, url, firstRequest);
    const body = html(url, port);
    if (body === null) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
