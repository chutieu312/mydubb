// Content script for https://www.udemy.com/*. Answers only this extension: the selection request
// from the service worker and side panel ports. Web pages cannot reach these listeners.

import { isGetSelectionRequest } from "../shared/messages";
import { PLAYER_PAGE_PORT } from "../shared/playback";
import { FloatingPlayer } from "./floating";
import { PageSession, selectionReply } from "./page";

const session = new PageSession({
  doc: document,
  win: window,
  extensionId: chrome.runtime.id,
  panelUrl: chrome.runtime.getURL("sidepanel.html"),
  playback: {
    connect: () => chrome.runtime.connect({ name: PLAYER_PAGE_PORT }),
    // The browser-test build opens the shadow root so Playwright can reach the controls.
    createPlayer: (actions) => new FloatingPlayer(document, window, actions, __MYDUBB_E2E__ ? "open" : "closed"),
  },
});

chrome.runtime.onConnect.addListener((port) => {
  session.acceptPort(port);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the extension's own service worker (no tab) may ask for the selection.
  if (sender.id !== chrome.runtime.id || sender.tab || !isGetSelectionRequest(message)) return false;
  sendResponse(selectionReply(document, window));
  return false;
});
