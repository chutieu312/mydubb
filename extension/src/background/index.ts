// Service worker entry. Listeners are registered synchronously at top level so Chrome can wake
// the worker for them; no state is kept in worker globals.

import { AUTH_KEY } from "../panel/auth";
import {
  MENU_ID,
  MENU_ITEM,
  handleAuthChanged,
  handleMenuClick,
  handleTabRemoved,
  openPanel,
  reachPage,
  type WorkerApi,
} from "./handlers";

const api: WorkerApi = {
  sidePanel: chrome.sidePanel,
  tabsSendMessage: (tabId, message, options) => chrome.tabs.sendMessage(tabId, message, options),
  session: chrome.storage.session,
  action: chrome.action,
  randomId: () => crypto.randomUUID(),
  now: () => Date.now(),
  notifyPlayer: (message) => chrome.runtime.sendMessage(message),
  injectPage: (tabId) => chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] }),
  notifyPanel: (message) => chrome.runtime.sendMessage(message),
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(MENU_ITEM);
  });
});

// Drafts are readable by the panel and this worker only, never by content scripts.
void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleMenuClick(api, info, tab);
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined || tab.id < 0) return;
  openPanel(api, tab.id);
  void reachPage(api, tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(api, tabId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  const change = changes[AUTH_KEY];
  if (area === "session" && change) handleAuthChanged(api, change.newValue);
});

// Browser tests only (dist-test/); `__MYDUBB_E2E__` is false in dist/ and this block is removed.
if (__MYDUBB_E2E__) {
  (globalThis as { mydubbE2E?: unknown }).mydubbE2E = {
    sendSelection: (tabId: number, selectionText: string, pageUrl: string) =>
      handleMenuClick(api, { menuItemId: MENU_ID, selectionText, frameId: 0, pageUrl }, { id: tabId }),
    // The toolbar button's click (Playwright cannot click it): the same steps, without the gesture.
    clickAction: (tabId: number) => {
      openPanel(api, tabId);
      return reachPage(api, tabId);
    },
  };
}
