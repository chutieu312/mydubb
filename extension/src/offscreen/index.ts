// Offscreen document (offscreen.html): owns the MyDubb audio of every tab (see hub.ts). It has only
// chrome.runtime: ports from the side panels and the Udemy content scripts, messages from the
// service worker, and the extension-origin BroadcastChannel that carries the MP3 Blob from a
// panel. It never sees the MyDubb token: the panel downloads the audio and hands over the Blob.

import { AUDIO_CHANNEL, PLAYER_PAGE_PORT, PLAYER_PANEL_PORT } from "../shared/playback";
import { PlaybackHub } from "./hub";

const hub = new PlaybackHub({
  extensionId: chrome.runtime.id,
  panelUrl: chrome.runtime.getURL("sidepanel.html"),
  createAudio: () => document.body.appendChild(new Audio()),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  randomId: () => crypto.randomUUID(),
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  close: () => window.close(),
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PLAYER_PANEL_PORT) hub.acceptPanel(port);
  else if (port.name === PLAYER_PAGE_PORT) hub.acceptPage(port);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Browser tests only (dist-test/): what is playing, read from the real media elements.
  if (__MYDUBB_E2E__ && (message as { type?: unknown } | null)?.type === "mydubbE2E:inspect") {
    sendResponse(
      [...hub.tabs].map(([tabId, { audio, view }]) => ({
        tabId,
        paused: audio.paused,
        currentTime: audio.currentTime,
        duration: audio.duration,
        rate: audio.playbackRate,
        blobSrc: audio.src.startsWith("blob:chrome-extension:"),
        floating: view.floating,
        lessonKey: view.lessonKey,
        audioElements: document.querySelectorAll("audio").length,
      })),
    );
    return false;
  }
  hub.onWorkerMessage(message, sender);
  return false;
});

new BroadcastChannel(AUDIO_CHANNEL).addEventListener("message", (event) => hub.receiveAudio(event.data));
