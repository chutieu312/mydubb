// Sync prototype: the toolbar button. Clicking it is the user gesture that gives the prototype
// temporary access to this tab (activeTab) and opens the lab as this tab's side panel. Nothing runs
// on a page before that click; the service worker keeps no state.

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  // Not awaited: sidePanel.open must run while the click still counts as a user gesture.
  void chrome.sidePanel.setOptions({ tabId: tab.id, path: `lab.html?tabId=${tab.id}`, enabled: true }).catch(() => undefined);
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
});
