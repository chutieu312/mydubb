// Service-worker logic, kept free of top-level state: anything that must survive the worker being
// stopped lives in chrome.storage.session (memory only, cleared when the browser closes).

import { UDEMY_ORIGIN } from "../shared/lesson";
import {
  draftKey,
  isSelectionReply,
  pendingKey,
  type GetSelectionRequest,
  type PendingSelection,
  type SelectionReply,
} from "../shared/messages";

export const MENU_ID = "mydubb-send-selection";
export const PANEL_PAGE = "sidepanel.html";

/** The Chrome APIs the worker uses, injectable for tests. */
export interface WorkerApi {
  sidePanel: Pick<typeof chrome.sidePanel, "open" | "setOptions">;
  tabsSendMessage(tabId: number, message: GetSelectionRequest, options: { frameId: number }): Promise<unknown>;
  session: Pick<chrome.storage.StorageArea, "set" | "remove">;
  action: Pick<typeof chrome.action, "setBadgeText" | "setTitle">;
  randomId(): string;
  now(): number;
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
  void api.action.setTitle({ tabId, title: "Open MyDubb Prototype" }).catch(() => undefined);
}

function isUdemyUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === UDEMY_ORIGIN;
  } catch {
    return false;
  }
}

/** "Send to MyDubb": open the panel, then hand the exact selection to it via session storage. */
export async function handleMenuClick(
  api: WorkerApi,
  info: Pick<chrome.contextMenus.OnClickData, "menuItemId" | "selectionText" | "frameId" | "pageUrl" | "frameUrl">,
  tab: Pick<chrome.tabs.Tab, "id"> | undefined,
): Promise<PendingSelection | null> {
  if (info.menuItemId !== MENU_ID) return null;
  const tabId = tab?.id;
  if (tabId === undefined || tabId < 0 || !isUdemyUrl(info.pageUrl)) return null;
  openPanel(api, tabId);

  const frameId = info.frameId ?? 0;
  let reply: SelectionReply | null = null;
  // The content script runs only in the top frame; it returns the selection with line breaks
  // intact. Elsewhere Chrome's own selectionText (which may collapse whitespace) is the fallback.
  if (frameId === 0) {
    try {
      const raw = await api.tabsSendMessage(tabId, { type: "mydubb:get-selection" }, { frameId: 0 });
      if (isSelectionReply(raw)) reply = raw;
    } catch {
      reply = null;
    }
  }

  let text = reply && reply.text.trim() !== "" ? reply.text : (info.selectionText ?? "");
  let problem: PendingSelection["problem"] = null;
  if (reply?.tooLong) {
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
  await api.session.remove([pendingKey(tabId), draftKey(tabId)]);
}
