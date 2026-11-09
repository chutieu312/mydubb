// Service-worker logic, kept free of top-level state: anything that must survive the worker being
// stopped lives in chrome.storage.session (memory only, cleared when the browser closes).

import { isLive, isStoredAuth } from "../panel/auth";
import { UDEMY_ORIGIN } from "../shared/lesson";
import {
  MAX_SELECTION_CHARS,
  isSelectionReply,
  pendingKey,
  tabKeys,
  type GetSelectionRequest,
  type PageInjected,
  type PendingSelection,
  type SelectionReply,
} from "../shared/messages";
import type { WorkerToPlayer } from "../shared/playback";

export const MENU_ID = "mydubb-send-selection";
/**
 * The "Send to MyDubb" item: on any http(s) page that has selected text. Chrome gives the selection
 * (selectionText) to the worker without any host permission, so no site access is needed for it;
 * handleMenuClick checks the page again before it acts.
 */
export const MENU_ITEM: chrome.contextMenus.CreateProperties = {
  id: MENU_ID,
  title: "Send to MyDubb",
  contexts: ["selection"],
  documentUrlPatterns: ["https://*/*", "http://*/*"],
};
export const PANEL_PAGE = "sidepanel.html";

/** The Chrome APIs the worker uses, injectable for tests. */
export interface WorkerApi {
  sidePanel: Pick<typeof chrome.sidePanel, "open" | "setOptions">;
  tabsSendMessage(tabId: number, message: GetSelectionRequest, options: { frameId: number }): Promise<unknown>;
  session: Pick<chrome.storage.StorageArea, "set" | "remove">;
  action: Pick<typeof chrome.action, "setBadgeText" | "setTitle">;
  randomId(): string;
  now(): number;
  /** chrome.runtime.sendMessage to the offscreen document (which may not exist). */
  notifyPlayer(message: WorkerToPlayer): Promise<unknown>;
  /**
   * chrome.scripting.executeScript of content.js into the tab's top frame. Allowed only while the
   * user's click on the MyDubb button or "Send to MyDubb" has given activeTab for that page; rejects
   * otherwise (chrome:// pages, the Web Store, another origin since the click).
   */
  injectPage(tabId: number): Promise<unknown>;
  /** chrome.runtime.sendMessage to the tab's side panel (which may not be open). */
  notifyPanel(message: PageInjected): Promise<unknown>;
}

/**
 * The user's click (toolbar button or menu) gave activeTab for this tab's page: the content script
 * goes into its top frame, so the panel can find the page's video for Sync. Nothing is read from
 * the page until the panel connects. On Udemy the manifest's copy is already there (the injected
 * one sees it and does nothing). A page that cannot be injected is simply not offered Sync.
 */
export async function reachPage(api: WorkerApi, tabId: number): Promise<boolean> {
  try {
    await api.injectPage(tabId);
  } catch {
    return false;
  }
  api.notifyPanel({ type: "mydubb:page-injected", tabId }).catch(() => undefined);
  return true;
}

export function panelPath(tabId: number): string {
  return `${PANEL_PAGE}?tabId=${tabId}`;
}

/**
 * Opens this tab's own side panel. Must run synchronously inside the user gesture (context menu or
 * toolbar click), so neither call is awaited before the other; failures are reported on the badge.
 */
export function openPanel(api: WorkerApi, tabId: number): void {
  void api.sidePanel.setOptions({ tabId, path: panelPath(tabId), enabled: true }).catch(() => undefined);
  api.sidePanel.open({ tabId }).then(
    () => clearOpenFailure(api, tabId),
    () => markOpenFailure(api, tabId),
  );
}

function markOpenFailure(api: WorkerApi, tabId: number): void {
  void api.action.setBadgeText({ tabId, text: "!" }).catch(() => undefined);
  void api.action
    .setTitle({ tabId, title: "MyDubb could not open its panel. Click here to open it." })
    .catch(() => undefined);
}

function clearOpenFailure(api: WorkerApi, tabId: number): void {
  void api.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  void api.action.setTitle({ tabId, title: "Open MyDubb" }).catch(() => undefined);
}

/** The page the menu was used on: Udemy (a content script lives there) or any other http(s) page. */
function pageKind(url: string | undefined): "udemy" | "web" | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin === UDEMY_ORIGIN) return "udemy";
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? "web" : null;
  } catch {
    return null;
  }
}

/**
 * "Send to MyDubb": open the panel, then hand the selection to it via session storage. On Udemy the
 * content script returns the exact selection (line breaks intact); on any other http(s) page there
 * is no content script and Chrome's own selectionText is all there is.
 */
export async function handleMenuClick(
  api: WorkerApi,
  info: Pick<chrome.contextMenus.OnClickData, "menuItemId" | "selectionText" | "frameId" | "pageUrl" | "frameUrl">,
  tab: Pick<chrome.tabs.Tab, "id"> | undefined,
): Promise<PendingSelection | null> {
  if (info.menuItemId !== MENU_ID) return null;
  const tabId = tab?.id;
  const kind = pageKind(info.pageUrl);
  if (tabId === undefined || tabId < 0 || kind === null) return null;
  openPanel(api, tabId);
  if (kind === "web") void reachPage(api, tabId);

  const frameId = info.frameId ?? 0;
  let reply: SelectionReply | null = null;
  // The Udemy content script runs only in the top frame; it returns the selection with line breaks
  // intact. Elsewhere Chrome's own selectionText (which may collapse whitespace) is the fallback.
  if (kind === "udemy" && frameId === 0) {
    try {
      const raw = await api.tabsSendMessage(tabId, { type: "mydubb:get-selection" }, { frameId: 0 });
      if (isSelectionReply(raw)) reply = raw;
    } catch {
      reply = null;
    }
  }

  let text = reply && reply.text.trim() !== "" ? reply.text : (info.selectionText ?? "");
  let problem: PendingSelection["problem"] = null;
  if (reply?.tooLong || text.length > MAX_SELECTION_CHARS) {
    text = "";
    problem = "too-long";
  } else if (text.trim() === "") {
    text = "";
    problem = "empty";
  }
  const pending: PendingSelection = {
    id: api.randomId(),
    text,
    problem,
    lessonKey: reply?.lesson?.key ?? null,
    at: api.now(),
  };
  await api.session.set({ [pendingKey(tabId)]: pending });
  return pending;
}

export async function handleTabRemoved(api: WorkerApi, tabId: number): Promise<void> {
  notify(api, { type: "mydubb:player-tab-closed", tabId });
  await api.session.remove(tabKeys(tabId));
}

/**
 * The stored MyDubb connection changed (connect, disconnect, refused token): the offscreen document
 * ends every playback session of another connection, also in tabs whose panel is closed.
 */
export function handleAuthChanged(api: WorkerApi, value: unknown): void {
  const connectionId = isStoredAuth(value) && isLive(value, api.now()) ? value.connectionId : null;
  notify(api, { type: "mydubb:player-identity", connectionId });
}

function notify(api: WorkerApi, message: WorkerToPlayer): void {
  // No offscreen document means no session to end.
  api.notifyPlayer(message).catch(() => undefined);
}
