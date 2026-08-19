// Service worker: toolbar click and in-page chip both open the side panel.
import { PENDING_THREAD_LOAD_KEY, type OpenSidePanelRequest } from "./lib/types";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("setPanelBehavior failed:", err));
});

chrome.runtime.onMessage.addListener((msg: OpenSidePanelRequest, sender) => {
  if (msg?.type !== "OPEN_SIDE_PANEL") return;
  const tabId = sender.tab?.id;
  if (!tabId) return;

  // Write before open() so a panel that is already alive can consume via onChanged.
  // Do not await — sidePanel.open must stay in the user-gesture stack.
  void chrome.storage.local.set({
    [PENDING_THREAD_LOAD_KEY]: { tabId, at: Date.now() },
  });

  const open = chrome.sidePanel.open({ tabId });
  open.catch((err) => {
    const windowId = sender.tab?.windowId;
    if (windowId == null) {
      console.error("sidePanel.open failed:", err);
      return;
    }
    chrome.sidePanel.open({ windowId }).catch((err2) => {
      console.error("sidePanel.open (window) failed:", err2);
    });
  });
});
