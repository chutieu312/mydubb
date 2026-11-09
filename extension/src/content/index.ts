// Content script. On https://www.udemy.com/* the manifest runs it; on an ordinary web page the
// extension injects it into the top frame (chrome.scripting, activeTab) when the user clicks the
// MyDubb button or "Send to MyDubb", for Sync with that page's video. It answers only this
// extension: the selection request from the service worker and side panel ports. Web pages cannot
// reach these listeners.

import { isGetSelectionRequest } from "../shared/messages";
import { UDEMY_ORIGIN } from "../shared/lesson";
import { PLAYER_PAGE_PORT } from "../shared/playback";
import { FloatingPlayer } from "./floating";
import { PageSession, selectionReply } from "./page";

// Injected again on a later click (or next to the manifest's copy on Udemy): one session per page.
const scope = globalThis as { mydubbContent?: true };
if (!scope.mydubbContent) {
  scope.mydubbContent = true;
  start();
}

function start(): void {
  const web = location.origin !== UDEMY_ORIGIN;
  const session = new PageSession({
    doc: document,
    win: window,
    extensionId: chrome.runtime.id,
    panelUrl: chrome.runtime.getURL("sidepanel.html"),
    web,
    playback: {
      connect: () => chrome.runtime.connect({ name: PLAYER_PAGE_PORT }),
      // The floating player belongs to Udemy; an ordinary page's session never shows one.
      // The browser-test build opens the shadow root so Playwright can reach the controls.
      createPlayer: (actions) =>
        web ? { render: () => undefined, hide: () => undefined } : new FloatingPlayer(document, window, actions, __MYDUBB_E2E__ ? "open" : "closed"),
    },
  });

  chrome.runtime.onConnect.addListener((port) => {
    session.acceptPort(port);
  });

  // The selection is read only on Udemy (the service worker never asks elsewhere).
  if (web) return;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only the extension's own service worker (no tab) may ask for the selection.
    if (sender.id !== chrome.runtime.id || sender.tab || !isGetSelectionRequest(message)) return false;
    sendResponse(selectionReply(document, window));
    return false;
  });
}
