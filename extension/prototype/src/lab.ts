// Sync prototype: the lab page, opened as the tab's side panel by the prototype's toolbar button
// (lab.html?tabId=N). It injects the probe on the user's click, decides whether the page has one
// identifiable video, then tests it in the order of the story: find and read it, Play/Pause from
// MyDubb (checked on the element), Sync with a local test MP3 through the real SyncController
// (src/offscreen/sync.ts, unchanged), and the binding ending when the video or the page changes.
// The report holds origins and numbers only.

import { SyncController, type SyncTraceEntry } from "../../src/offscreen/sync";
import { clockLabel, rateLabel, syncNoticeText, syncStatusText, type SyncNotice, type SyncSource } from "../../src/shared/sync";
import type { VideoState } from "../../src/shared/messages";
import { recoveries, steadyStats, testSpan, type DriftSample, type Operation } from "./drift";
import { PROBE_PORT, type FrameScan, type LabToProbe, type ProbeToLab, type Verified } from "./protocol";

const SAMPLE_MS = 250;
const MAX_SAMPLES = 8000;
const MAX_LOG = 400;
// An inaccessible frame this large may hold the main player: the choice is not made without it.
const PLAYER_MIN_WIDTH = 160;
const PLAYER_MIN_HEIGHT = 90;

const tabId = Number(new URLSearchParams(location.search).get("tabId"));
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const audio = $<HTMLAudioElement>("audio");
const started = performance.now();
const secondsSince = (t: number) => ((t - started) / 1000).toFixed(2);

interface Frame {
  frameId: number;
  scan: FrameScan;
}

let frames: Frame[] = [];
let access: { ok: boolean; text: string } = { ok: false, text: "Not scanned yet." };
let inaccessible: string[] = [];
let decision: { ok: boolean; text: string } | null = null;
let target: { frameId: number; videoId: number; origin: string; top: boolean } | null = null;
let port: chrome.runtime.Port | null = null;
let bound = false;
let video: { state: VideoState; rate: number; muted: boolean } | null = null;
let controller: SyncController | null = null;
let span: { start: number; end: number; rate: number; mp3: number } | null = null;
let sampler: number | null = null;
let nextRequest = 1;
let lastVideoEvent = "";
const pendingCommands = new Map<number, string>();
const controlResults: (Verified & { command: string; t: string })[] = [];
const samples: DriftSample[] = [];
const operations: Operation[] = [];
const lifecycle: { t: string; event: string }[] = [];
const trace: SyncTraceEntry[] = [];
const notices: { t: string; notice: SyncNotice }[] = [];
const log: string[] = [];

function note(text: string): void {
  log.push(`${secondsSince(performance.now())} ${text}`);
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
}

function operation(label: string): void {
  operations.push({ t: performance.now(), label });
  note(`op ${label}`);
}

/** A MyDubb operation (not a video event) in the last second. */
function recentOperation(): boolean {
  const last = [...operations].reverse().find((op) => !op.label.startsWith("video:"));
  return last !== undefined && performance.now() - last.t < 1000;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- 1. Find the video -------------------------------------------------------------------------

async function scan(): Promise<void> {
  teardown("rescan");
  frames = [];
  decision = null;
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["probe.js"] });
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (globalThis as { __mydubbProto?: { scan(): unknown } }).__mydubbProto?.scan() ?? null,
    });
    frames = results.filter((r) => r.result).map((r) => ({ frameId: r.frameId, scan: r.result as FrameScan }));
    access = { ok: frames.length > 0, text: `Probe running in ${frames.length} frame(s).` };
  } catch (error) {
    // Typically: no access (the toolbar button was not clicked on this page, or the page changed since).
    access = { ok: false, text: `No access to this tab: ${errorText(error)}` };
  }
  note(`scan: ${access.text}`);
  decide();
  render();
}

function decide(): void {
  const reachable = new Set(frames.map((f) => f.scan.origin));
  const large = frames.flatMap((f) =>
    f.scan.iframes.filter((i) => i.origin && i.rendered && i.width >= PLAYER_MIN_WIDTH && i.height >= PLAYER_MIN_HEIGHT).map((i) => i.origin!),
  );
  inaccessible = [...new Set(large)].filter((o) => !reachable.has(o));
  const ambiguous = frames.filter((f) => f.scan.pick.kind === "ambiguous");
  const picked = frames.filter((f) => f.scan.pick.kind === "video");
  const userPlayed = picked.filter((f) => f.scan.pick.kind === "video" && f.scan.pick.reason === "user-played");
  const shadow = frames.reduce((n, f) => n + f.scan.shadowVideos, 0);
  const decorative = frames.reduce((n, f) => n + f.scan.videos.filter((v) => v.decorative).length, 0);
  const hidden = inaccessible.length > 0 ? ` Frames from ${inaccessible.join(", ")} are not accessible and may hold a player.` : "";
  if (frames.length === 0) {
    decision = { ok: false, text: "Not compatible: the page cannot be accessed." };
  } else if (ambiguous.length > 0) {
    const n = ambiguous.reduce((sum, f) => sum + (f.scan.pick.kind === "ambiguous" ? f.scan.pick.candidates : 0), 0);
    decision = {
      ok: false,
      text: `Not compatible yet: ${n} videos and none of them is identified as the main one. Play the main video once on the page, then Scan again.`,
    };
  } else if (picked.length === 0) {
    decision = {
      ok: false,
      text:
        `Not compatible: no video found.` +
        (decorative > 0 ? ` ${decorative} muted looping video(s) are taken as a preview or background.` : "") +
        (shadow > 0 ? ` ${shadow} video(s) are inside a shadow root, which the generic controller does not search.` : "") +
        hidden,
    };
  } else if (picked.length > 1 && userPlayed.length !== 1) {
    decision = { ok: false, text: `Not compatible yet: ${picked.length} frames each have a video. Play the main video once, then Scan again.` };
  } else {
    const chosen = picked.length === 1 ? picked[0]! : userPlayed[0]!;
    const pick = chosen.scan.pick as Extract<FrameScan["pick"], { kind: "video" }>;
    if (inaccessible.length > 0 && pick.reason !== "user-played") {
      decision = { ok: false, text: `Not sure yet:${hidden} Allow access to them, or play the main video once and Scan again.` };
    } else {
      target = { frameId: chosen.frameId, videoId: pick.id, origin: chosen.scan.origin, top: chosen.scan.top };
      decision = {
        ok: true,
        text: `Video identified in the ${chosen.scan.top ? "top frame" : `frame of ${chosen.scan.origin}`} (${pick.reason}).`,
      };
      connect();
    }
  }
  note(`decision: ${decision.text}`);
}

function connect(): void {
  if (!target) return;
  const p = chrome.tabs.connect(tabId, { name: PROBE_PORT, frameId: target.frameId });
  port = p;
  p.onMessage.addListener((message: ProbeToLab) => onProbe(message));
  p.onDisconnect.addListener(() => {
    if (port !== p) return;
    port = null;
    lifecycle.push({ t: secondsSince(performance.now()), event: "port-closed (page reloaded, navigated or closed)" });
    teardown("the page went away (reload, navigation or tab closed)");
    render();
  });
  send({ type: "bind", videoId: target.videoId });
}

function send(message: LabToProbe): boolean {
  if (!port) return false;
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/** Ends the binding: Sync off, audio paused, port closed. */
function teardown(reason: string): void {
  if (controller) {
    controller.dispose();
    controller = null;
  }
  stopSampler();
  if (!audio.paused) audio.pause();
  const p = port;
  port = null;
  p?.disconnect();
  if (bound) note(`binding ended: ${reason}`);
  bound = false;
  target = null;
  video = null;
  pendingCommands.clear();
}

function onProbe(message: ProbeToLab): void {
  switch (message.type) {
    case "bound":
      if (message.ok) {
        bound = true;
        note(`bound to video #${message.videoId}`);
      } else {
        decision = { ok: false, text: `The video changed during the scan (${message.error}). Scan again.` };
        teardown(message.error);
      }
      break;
    case "state":
      video = { state: message.state, rate: message.rate, muted: message.muted };
      break;
    case "result": {
      const command = pendingCommands.get(message.requestId) ?? "?";
      pendingCommands.delete(message.requestId);
      controlResults.push({ command, t: secondsSince(performance.now()), ...message.verified });
      note(`${command}: ${message.verified.error ?? "ok"} → ${message.verified.outcome} (${message.verified.timeBefore.toFixed(2)} → ${message.verified.timeAfter.toFixed(2)})`);
      break;
    }
    case "sample":
      onSample(message.sample);
      return;
    case "lost":
      lifecycle.push({ t: secondsSince(performance.now()), event: `lost: ${message.reason}` });
      teardown(`the video was ${message.reason}`);
      decision = { ok: false, text: `The bound video is gone (${message.reason}); MyDubb stopped. Scan again for the new one.` };
      break;
    case "url":
      lifecycle.push({ t: secondsSince(performance.now()), event: `url ${message.change} changed (binding kept)` });
      note(`url ${message.change} changed, binding kept`);
      break;
    case "video-reply":
      controller?.onVideoReply(message);
      return;
    case "video-event":
      note(`video event ${message.event} (t=${message.video.currentTime.toFixed(2)}, rate=${message.video.rate})`);
      // A page action is an operation of its own; buffering right after MyDubb's own operation
      // (a seek of a playing video waits for data) belongs to that operation.
      if (message.event.startsWith("user-") || message.event.startsWith("rate-") || message.event === "visible") {
        operation(`video:${message.event}`);
      } else if ((message.event === "waiting" || (message.event === "playing" && lastVideoEvent === "waiting")) && !recentOperation()) {
        operation(`video:${message.event === "playing" ? "buffering-end" : "waiting"}`);
      }
      lastVideoEvent = message.event;
      controller?.onVideoEvent(message.syncId, message.event, message.video);
      break;
  }
  render();
}

// ---- 2. Play / Pause from MyDubb ---------------------------------------------------------------

function videoCommand(command: "play" | "pause" | "seek-by", delta?: number): void {
  if (!bound) return;
  if (controller?.active) {
    note("Sync is on: use the Sync controls (step 3)");
    return render();
  }
  const requestId = nextRequest++;
  pendingCommands.set(requestId, command === "seek-by" ? `seek ${delta! > 0 ? "+" : ""}${delta}s` : command);
  send({ type: "cmd", requestId, command, ...(delta !== undefined ? { delta } : {}) });
}

// ---- 3. Sync -----------------------------------------------------------------------------------

function controllerDeps() {
  return {
    post: (message: LabToProbe) => send(message),
    linked: () => bound,
    randomId: () => crypto.randomUUID(),
    now: () => performance.now(),
    setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
    clearTimeout: (id: number) => window.clearTimeout(id),
    changed: () => {
      const notice = controller?.view().notice ?? null;
      if (notice && notices.at(-1)?.notice !== notice) notices.push({ t: secondsSince(performance.now()), notice });
      render();
    },
    // One tab, one test audio: nothing else to pause.
    claim: () => undefined,
    log: (entry: SyncTraceEntry) => {
      trace.push(entry);
      if (trace.length > 400) trace.splice(0, trace.length - 400);
      if (entry.step === "op:seek" && !operations.some((op) => entry.t - op.t < 50)) note("drift correction: seek video");
    },
  };
}

async function syncOn(): Promise<void> {
  if (!bound || video?.state.status !== "ready") return note("Sync: no bound video");
  const mp3 = audio.duration;
  if (!Number.isFinite(mp3) || mp3 <= 0) return note("Sync: the test audio is not loaded yet");
  const v = video.state;
  const rate = Number(($<HTMLSelectElement>("rate")).value);
  const result = testSpan(v.currentTime, v.seekStart ?? 0, v.seekEnd ?? v.duration ?? 0, mp3, rate);
  if ("error" in result) {
    note(`Sync: the video is shorter than ${(mp3 * rate).toFixed(1)} s, the span this MP3 needs at ${rate}x`);
    return render();
  }
  span = { ...result, rate, mp3 };
  const baseline = result.end - result.start;
  const source: SyncSource = { mode: "timed", start: result.start, end: result.end, baseline, speed: baseline / mp3 };
  controller?.dispose();
  audio.currentTime = 0;
  controller = new SyncController(source, audio, controllerDeps());
  operation(`sync-on R=${rate}`);
  startSampler();
  await controller.enable();
  render();
}

function syncOff(): void {
  if (!controller?.active) return;
  operation("sync-off");
  controller.disable();
  stopSampler();
}

function audioPlay(): void {
  if (controller?.active) {
    operation("play");
    void controller.play();
  } else {
    // Sync off or unavailable: the audio on its own (the "listen without sync" fallback).
    void audio.play().catch((error: unknown) => note(`audio play failed: ${errorText(error)}`));
  }
}

function audioPause(): void {
  if (controller?.active) {
    operation("pause");
    controller.pause();
  } else audio.pause();
}

function audioSeek(to: number, label: string): void {
  const target = Math.max(0, Math.min(Number.isFinite(audio.duration) ? audio.duration : 0, to));
  if (controller?.active) {
    operation(label);
    void controller.seek(target);
  } else audio.currentTime = target;
}

function startSampler(): void {
  stopSampler();
  sampler = window.setInterval(() => {
    if (controller?.active && bound) send({ type: "sample", requestId: nextRequest++ });
  }, SAMPLE_MS);
}

function stopSampler(): void {
  if (sampler !== null) window.clearInterval(sampler);
  sampler = null;
}

function onSample(s: { currentTime: number; paused: boolean; waiting: boolean; rate: number }): void {
  if (!span) return;
  const a = audio.currentTime;
  samples.push({
    t: performance.now(),
    audio: a,
    video: s.currentTime,
    drift: (s.currentTime - span.start) / span.rate - a,
    audioPaused: audio.paused,
    videoPaused: s.paused,
    videoWaiting: s.waiting,
    videoRate: s.rate,
  });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  scheduleRender();
}

for (const name of ["play", "pause", "waiting", "playing", "ended", "error"]) {
  audio.addEventListener(name, () => {
    controller?.onAudioEvent(name);
    render();
  });
}
audio.addEventListener("timeupdate", () => scheduleRender());
audio.addEventListener("loadedmetadata", () => render());

// ---- 4. Report ---------------------------------------------------------------------------------

function report() {
  return {
    kind: "mydubb-sync-prototype-report",
    version: 1,
    createdAt: new Date().toISOString(),
    pageName: ($<HTMLInputElement>("page-name")).value.slice(0, 120),
    browser: navigator.userAgent,
    privacy: "Origins and media numbers only: no page path, title or text.",
    access,
    frames: frames.map((f) => ({ frameId: f.frameId, ...f.scan })),
    inaccessibleOrigins: inaccessible,
    decision,
    target: target ? { frameId: target.frameId, origin: target.origin, top: target.top } : null,
    controlResults,
    sync: {
      span,
      notices,
      stats: controller?.stats ?? null,
      steady: steadyStats(samples, operations),
      recoveries: recoveries(samples, operations),
      samples: samples.length,
      // The last samples, as measured (positions in seconds; t relative to the lab's start).
      tail: samples.slice(-40).map((x) => ({ ...x, t: secondsSince(x.t) })),
      operations: operations.map((op) => ({ t: secondsSince(op.t), label: op.label })),
    },
    lifecycle,
    trace: trace.slice(-200).map((e) => ({ ...e, t: secondsSince(e.t) })),
    log: log.slice(-300),
  };
}

async function copyReport(): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify(report(), null, 2));
    $("report-status").textContent = "Copied.";
  } catch (error) {
    $("report-status").textContent = `Copy failed (${errorText(error)}); use Save report.`;
  }
}

function saveReport(): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report(), null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `mydubb-sync-report-${Date.now()}.json`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- Rendering ---------------------------------------------------------------------------------

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function facts(list: HTMLElement, rows: [string, string][]): void {
  list.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

function items(list: HTMLElement, texts: string[]): void {
  list.replaceChildren(
    ...texts.map((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      return li;
    }),
  );
}

const num = (n: number | null | undefined, digits = 2) => (n === null || n === undefined ? "–" : n.toFixed(digits));

function render(): void {
  $("tab-line").textContent = `Tab ${tabId}`;
  const accessLine = $("access");
  accessLine.textContent = access.text;
  accessLine.className = access.ok ? "ok" : "bad";
  items(
    $("frames"),
    frames.map((f) => {
      const s = f.scan;
      const vids = s.videos
        .map((v) => `#${v.id} ${v.width}×${v.height}${v.rendered ? "" : " hidden"} ${v.source}${v.paused ? " paused" : " playing"}${v.muted ? " muted" : ""}${v.autoplay ? " autoplay" : ""}${v.loop ? " loop" : ""} ${num(v.currentTime, 1)}/${num(v.duration, 1)}s`)
        .join("; ");
      const pick = s.pick.kind === "video" ? `pick #${s.pick.id} (${s.pick.reason})` : s.pick.kind === "ambiguous" ? `ambiguous (${s.pick.candidates})` : "no pick";
      return `${s.top ? "top" : "frame"} ${s.origin}: ${s.videos.length} video(s)${vids ? ` [${vids}]` : ""}, ${pick}, iframes ${s.iframes.length}${s.shadowVideos ? `, shadow-root videos ${s.shadowVideos}` : ""}`;
    }),
  );
  const grants = $("grants");
  grants.replaceChildren(
    ...inaccessible.map((origin) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `Allow access to ${origin}`;
      b.addEventListener("click", () => void grant(origin));
      return b;
    }),
  );
  const top = frames.find((f) => f.scan.top);
  const siteButton = $<HTMLButtonElement>("grant-site");
  siteButton.hidden = !top || !/^https?:/.test(top.scan.origin);
  if (top) siteButton.textContent = `Always allow on ${top.scan.origin}`;
  const decisionLine = $("decision");
  decisionLine.textContent = decision?.text ?? "";
  decisionLine.className = `decision ${decision?.ok ? "ok" : "bad"}`;

  const v = video?.state;
  facts(
    $("video-state"),
    v && v.status === "ready" && bound
      ? [
          ["Position", `${num(v.currentTime)} / ${num(v.duration)} s`],
          ["Seekable", `${num(v.seekStart)}–${num(v.seekEnd)} s`],
          ["State", `${v.paused ? "paused" : "playing"}${v.waiting ? ", buffering" : ""}${v.ended ? ", ended" : ""}, readyState ${v.readyState}`],
          ["Rate / muted", `${video!.rate} / ${video!.muted ? "muted" : "sound on"}`],
          ["Error", v.error ?? "none"],
        ]
      : [["Video", bound ? "waiting for state" : "not bound"]],
  );
  items(
    $("control-results"),
    controlResults.map((r) => `${r.t}s ${r.command}: ${r.error ?? "accepted"} → ${r.outcome} (time ${num(r.timeBefore)} → ${num(r.timeAfter)}, checked ${r.waitedMs} ms)`),
  );

  const view = controller?.view() ?? null;
  const toggle = $<HTMLButtonElement>("sync-toggle");
  toggle.textContent = controller?.active ? "Turn Sync off" : "Turn Sync on";
  toggle.setAttribute("aria-pressed", String(Boolean(controller?.active)));
  toggle.disabled = !bound;
  $("sync-status").textContent = view
    ? `${syncStatusText(view)}${span ? ` · span ${clockLabel(span.start)} → ${clockLabel(span.end)} at ${rateLabel(span.rate)}` : ""}`
    : bound
      ? "Sync: OFF"
      : "Sync: no bound video";
  $("sync-notice").textContent = view ? syncNoticeText(view) : "";
  const seek = $<HTMLInputElement>("a-seek");
  if (Number.isFinite(audio.duration)) seek.max = String(audio.duration);
  if (document.activeElement !== seek) seek.value = String(audio.currentTime);
  const last = samples.at(-1);
  const steady = steadyStats(samples, operations);
  facts($("drift"), [
    ["Audio", `${num(audio.currentTime)} / ${num(audio.duration)} s, ${audio.paused ? "paused" : "playing"} (1x)`],
    ["Video", last ? `${num(last.video)} s, ${last.videoPaused ? "paused" : last.videoWaiting ? "buffering" : "playing"}, rate ${last.videoRate}` : "–"],
    ["Drift now", last ? `${num(last.drift, 3)} s` : "–"],
    ["Steady |d|", steady.samples ? `median ${num(steady.medianAbs, 3)}, p95 ${num(steady.p95Abs, 3)}, max ${num(steady.maxAbs, 3)} s (${steady.samples} samples)` : "–"],
    ["Corrections", controller ? `${controller.stats.corrections} (coordinator max |d| ${num(controller.stats.maxAbsDrift, 3)} s over ${controller.stats.samples} checks)` : "–"],
  ]);
  items($("log"), log.slice(-80).reverse());
}

async function grant(origin: string): Promise<void> {
  // A user gesture in this page: Chrome asks the user.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
  note(`access to ${origin}: ${granted ? "granted" : "refused"}`);
  if (granted) await scan();
  else render();
}

$("scan").addEventListener("click", () => void scan());
$("grant-site").addEventListener("click", () => {
  const top = frames.find((f) => f.scan.top);
  if (top) void grant(top.scan.origin);
});
$("v-play").addEventListener("click", () => videoCommand("play"));
$("v-pause").addEventListener("click", () => videoCommand("pause"));
$("v-back").addEventListener("click", () => videoCommand("seek-by", -5));
$("v-fwd").addEventListener("click", () => videoCommand("seek-by", 5));
$("sync-toggle").addEventListener("click", () => (controller?.active ? syncOff() : void syncOn()));
$("a-play").addEventListener("click", audioPlay);
$("a-pause").addEventListener("click", audioPause);
$("a-back").addEventListener("click", () => audioSeek(audio.currentTime - 5, "seek -5s"));
$("a-fwd").addEventListener("click", () => audioSeek(audio.currentTime + 5, "seek +5s"));
$("a-seek").addEventListener("change", (event) => audioSeek(Number((event.target as HTMLInputElement).value), "seek bar"));
$("copy-report").addEventListener("click", () => void copyReport());
$("save-report").addEventListener("click", saveReport);

// Scan, Play video, Sync on and Play asked by the prototype's own service worker (no user gesture comes with them):
// the browser tests use them to act without the user activation a click in the lab carries along.
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  const m = message as { type?: unknown; tabId?: unknown } | null;
  if (sender.id !== chrome.runtime.id || sender.tab || m?.tabId !== tabId) return false;
  if (m.type === "proto:scan") void scan();
  if (m.type === "proto:play-video") videoCommand("play");
  if (m.type === "proto:sync-on") void syncOn();
  if (m.type === "proto:play") audioPlay();
  return false;
});

// For the prototype's browser tests: the same report the PO copies.
(globalThis as unknown as { protoReport: typeof report }).protoReport = report;

render();
