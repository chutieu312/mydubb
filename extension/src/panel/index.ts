// Side panel for one tab (sidepanel.html?tabId=N). It talks only to the content script of that tab
// through a port, so commands can never reach another tab. The draft lives in
// chrome.storage.session (memory only); it is sent to MyDubb only when the user chooses Generate
// audio (panel/dubbing.ts). Nothing of the MyDubb account ever reaches the content script.

import {
  PANEL_PORT_NAME,
  draftKey,
  isContentToPanel,
  isDraftRecord,
  isPendingSelection,
  pendingKey,
  type CommandError,
  type CommandMessage,
  type CommandResult,
  type DraftRecord,
  type PageState,
  type PendingSelection,
} from "../shared/messages";
import { createApi } from "./api";
import {
  belongsElsewhere,
  decidePending,
  draftFromSelection,
  draftIsStale,
  formatTime,
  type CurrentLesson,
} from "./draft";
import { Dubbing } from "./dubbing";

const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 15;
const SAVE_DEBOUNCE_MS = 250;
const SEEK_SECONDS = 5;

const COMMAND_ERRORS: Record<CommandError, string> = {
  "no-video": "No lecture video is attached.",
  stale: "The lecture or video changed before the command ran, so nothing was done. Check the panel and try again.",
  "not-ready": "The video is not ready yet. Wait for it to load.",
  "not-seekable": "The video cannot be seeked yet.",
  "play-blocked": "Chrome blocked playback. Click play once in the Udemy player, then use the panel again.",
  "play-interrupted": "Playback was interrupted (the video was paused or changed).",
  "play-failed": "The video could not start playing.",
  invalid: "The command was rejected.",
};

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const ui = {
  tabLabel: byId("tab-label"),
  lessonLabel: byId("lesson-label"),
  linkStatus: byId("link-status"),
  reconnect: byId<HTMLButtonElement>("reconnect"),
  transcript: byId<HTMLTextAreaElement>("transcript"),
  clear: byId<HTMLButtonElement>("clear"),
  draftStatus: byId("draft-status"),
  confirm: byId("confirm"),
  confirmReplace: byId<HTMLButtonElement>("confirm-replace"),
  confirmKeep: byId<HTMLButtonElement>("confirm-keep"),
  videoStatus: byId("video-status"),
  timeCurrent: byId("time-current"),
  timeDuration: byId("time-duration"),
  back: byId<HTMLButtonElement>("back"),
  playPause: byId<HTMLButtonElement>("playpause"),
  forward: byId<HTMLButtonElement>("forward"),
  videoError: byId("video-error"),
};

function parseTabId(search: string): number | null {
  const raw = new URLSearchParams(search).get("tabId");
  if (raw === null || !/^\d{1,10}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

class Panel {
  private port: chrome.runtime.Port | null = null;
  private receivedState = false;
  private retries = 0;
  private retryTimer: number | null = null;
  private saveTimer: number | null = null;
  private tabClosed = false;
  private state: PageState | null = null;
  private draft: DraftRecord | null = null;
  private awaitingConfirm: PendingSelection | null = null;
  private nextRequestId = 1;
  private readonly cleanup = new AbortController();
  private readonly dubbing: Dubbing;

  constructor(private readonly tabId: number) {
    this.dubbing = new Dubbing(
      {
        tabId,
        origin: __MYDUBB_ORIGIN__,
        extensionId: chrome.runtime.id,
        api: createApi({ origin: __MYDUBB_ORIGIN__, fetch: (input, init) => fetch(input, init) }),
        storage: chrome.storage.session,
        launchWebAuthFlow: launchAuthWindow,
        randomId: () => crypto.randomUUID(),
        now: () => Date.now(),
        createObjectURL: (blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
      },
      { currentLesson: () => this.currentLesson(), transcript: () => ui.transcript.value },
    );
  }

  async start(): Promise<void> {
    ui.tabLabel.textContent = `#${this.tabId}`;
    const signal = this.cleanup.signal;
    ui.transcript.addEventListener("input", () => this.onEdit(), { signal });
    ui.clear.addEventListener("click", () => this.onClear(), { signal });
    ui.confirmReplace.addEventListener("click", () => this.resolveConfirm(true), { signal });
    ui.confirmKeep.addEventListener("click", () => this.resolveConfirm(false), { signal });
    ui.playPause.addEventListener("click", () => this.sendPlayPause(), { signal });
    ui.back.addEventListener("click", () => this.send("seek", -SEEK_SECONDS), { signal });
    ui.forward.addEventListener("click", () => this.send("seek", SEEK_SECONDS), { signal });
    ui.reconnect.addEventListener("click", () => this.connect(true), { signal });
    window.addEventListener("pagehide", () => this.dispose(), { signal });

    chrome.storage.onChanged.addListener(this.onStorageChanged);
    chrome.tabs.onRemoved.addListener(this.onTabRemoved);
    chrome.tabs.onUpdated.addListener(this.onTabUpdated);

    try {
      await chrome.tabs.get(this.tabId);
    } catch {
      this.markTabClosed();
      return;
    }
    const stored = await chrome.storage.session.get([draftKey(this.tabId), pendingKey(this.tabId)]);
    const draft = stored[draftKey(this.tabId)];
    this.draft = isDraftRecord(draft) ? draft : null;
    ui.transcript.value = this.draft?.text ?? "";
    const dubbing = this.dubbing.start();
    this.connect(true);
    const pending = stored[pendingKey(this.tabId)];
    if (isPendingSelection(pending)) this.processPending(pending);
    await dubbing;
  }

  private dispose(): void {
    this.cleanup.abort();
    // Stops following the job and releases the audio; the job itself keeps running on MyDubb.
    this.dubbing.dispose();
    chrome.storage.onChanged.removeListener(this.onStorageChanged);
    chrome.tabs.onRemoved.removeListener(this.onTabRemoved);
    chrome.tabs.onUpdated.removeListener(this.onTabUpdated);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveDraftNow();
    }
    this.port?.disconnect();
    this.port = null;
  }

  // ---- Connection to the tab ----------------------------------------------------------------

  private connect(resetRetries: boolean): void {
    if (this.tabClosed || this.port) return;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (resetRetries) this.retries = 0;
    ui.reconnect.hidden = true;
    this.receivedState = false;
    let port: chrome.runtime.Port;
    try {
      port = chrome.tabs.connect(this.tabId, { name: PANEL_PORT_NAME, frameId: 0 });
    } catch {
      this.onDisconnect();
      return;
    }
    this.port = port;
    port.onMessage.addListener((message: unknown) => {
      if (this.port !== port || !isContentToPanel(message)) return;
      if (message.type === "state") {
        this.receivedState = true;
        this.retries = 0;
        this.applyState(message.state);
      } else {
        this.applyResult(message);
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (this.port === port) this.onDisconnect();
    });
  }

  private onDisconnect(): void {
    const hadState = this.receivedState;
    this.port = null;
    this.state = null;
    this.renderVideo();
    if (this.tabClosed) return;
    if (hadState) {
      this.setLinkStatus("Connection to the Udemy tab was lost (reload or navigation). Reconnecting…");
    } else if (this.retries === 0) {
      this.setLinkStatus(
        "MyDubb is not active in this tab. Open a Udemy lecture page; if it is already open, reload the tab.",
      );
    }
    if (this.retries >= MAX_RETRIES) {
      this.setLinkStatus("Could not reach the Udemy tab. Reload the lecture tab, then click Reconnect.");
      ui.reconnect.hidden = false;
      return;
    }
    this.retries += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect(false);
    }, RETRY_DELAY_MS);
  }

  private readonly onTabRemoved = (tabId: number): void => {
    if (tabId === this.tabId) this.markTabClosed();
  };

  private readonly onTabUpdated = (tabId: number, change: { status?: string }): void => {
    if (tabId !== this.tabId || this.tabClosed) return;
    if (change.status === "loading" && this.port) {
      this.setLinkStatus("The Udemy tab is loading…");
    }
    if (change.status === "complete" && !this.port) this.connect(true);
  };

  private markTabClosed(): void {
    this.tabClosed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.port?.disconnect();
    this.port = null;
    this.state = null;
    this.awaitingConfirm = null;
    ui.confirm.hidden = true;
    ui.reconnect.hidden = true;
    ui.lessonLabel.textContent = "—";
    this.setLinkStatus("The linked tab was closed. Open a Udemy lecture and send a selection to start again.");
    this.renderVideo();
    this.dubbing.tabClosed();
  }

  // ---- Page state -----------------------------------------------------------------------------

  private applyState(next: PageState): void {
    const previous = this.state;
    const prevKey = previous?.lesson?.key ?? null;
    const nextKey = next.lesson?.key ?? null;
    this.state = next;

    const lessonChanged = previous !== null && prevKey !== nextKey;
    if (lessonChanged) this.setVideoError("");
    // Every state is checked against the draft's own lecture, not only the first one after
    // connecting: draft A must not survive a detour (A -> non-lecture page -> B) under B's label.
    if (draftIsStale(this.draft, nextKey) || (lessonChanged && this.draft?.lessonKey === null)) {
      this.discardDraft(
        nextKey ? "The lecture changed. The previous draft was cleared." : "You left the lecture. The previous draft was cleared.",
      );
    } else if (this.awaitingConfirm && belongsElsewhere(this.awaitingConfirm.lessonKey, nextKey)) {
      this.awaitingConfirm = null;
      ui.confirm.hidden = true;
      this.setDraftStatus("The lecture changed, so the waiting selection was discarded.");
    } else if (!previous && this.draft && this.draft.lessonKey === null && nextKey) {
      // A draft started before the tab's lecture was known belongs to the first lecture reported.
      this.draft = { ...this.draft, lessonKey: nextKey };
      this.scheduleSave();
    }
    if (
      previous?.video.status === "ready" &&
      next.video.status === "ready" &&
      prevKey === nextKey &&
      previous.video.id !== next.video.id
    ) {
      this.setLinkStatus("The video player was replaced. Controls now follow the new video.");
    } else if (!previous) {
      this.setLinkStatus(next.lesson ? "Connected to the lecture tab." : "This tab is not a Udemy lecture page.");
    }
    ui.reconnect.hidden = true;
    ui.lessonLabel.textContent = next.lesson
      ? `${next.lesson.title || "Untitled lecture"} (lecture ${next.lesson.lectureId})`
      : "Not a Udemy lecture page";
    this.renderVideo();
    // After the draft decision above, so the form and the job follow the same lecture rule.
    this.dubbing.lessonState(nextKey);
  }

  private renderVideo(): void {
    const video = this.state?.video;
    const connected = this.port !== null && this.state !== null;
    let status: string;
    if (!connected) {
      status = "Video controls are unavailable until the lecture tab is connected.";
    } else if (!this.state?.lesson) {
      status = "Open a Udemy lecture to control its video.";
    } else if (!video || video.status === "none") {
      status = "No lecture video found yet. Controls are disabled until the video appears.";
    } else if (video.status === "ambiguous") {
      status = `Found ${video.candidates} videos and cannot tell which one is the lecture. Start the lecture video once in the Udemy player; MyDubb will follow it.`;
    } else if (video.error) {
      status = video.error;
    } else if (video.readyState < 1) {
      status = "The video is loading…";
    } else if (video.waiting) {
      status = "Buffering…";
    } else if (video.ended) {
      status = "Ended.";
    } else {
      status = video.paused ? "Paused." : "Playing.";
    }
    if (connected && this.state && !this.state.online) status += " You are offline.";
    ui.videoStatus.textContent = status;

    const ready = connected && video?.status === "ready" ? video : null;
    ui.playPause.disabled = !ready;
    ui.playPause.textContent = ready && !ready.paused ? "Pause" : "Play";
    ui.playPause.setAttribute("aria-label", ready && !ready.paused ? "Pause video" : "Play video");
    const seekable = !!ready && ready.readyState >= 1 && ready.seekStart !== null;
    ui.back.disabled = !seekable;
    ui.forward.disabled = !seekable;
    ui.timeCurrent.textContent = ready ? formatTime(ready.currentTime) : "--:--";
    ui.timeDuration.textContent = ready ? formatTime(ready.duration) : "--:--";
  }

  // ---- Commands -------------------------------------------------------------------------------

  private sendPlayPause(): void {
    const video = this.state?.video;
    if (video?.status !== "ready") return;
    this.send(video.paused ? "play" : "pause");
  }

  private send(command: CommandMessage["command"], delta?: number): void {
    const lessonKey = this.state?.lesson?.key;
    const video = this.state?.video;
    if (!this.port || !lessonKey || video?.status !== "ready") return;
    const message: CommandMessage = {
      type: "command",
      requestId: this.nextRequestId++,
      command,
      lessonKey,
      videoId: video.id,
      ...(delta !== undefined ? { delta } : {}),
    };
    this.setVideoError("");
    try {
      this.port.postMessage(message);
    } catch {
      this.setVideoError("The Udemy tab is not connected.");
    }
  }

  private applyResult(result: CommandResult): void {
    if (!result.ok) this.setVideoError(COMMAND_ERRORS[result.error ?? "invalid"] ?? COMMAND_ERRORS.invalid);
  }

  private setVideoError(text: string): void {
    ui.videoError.textContent = text;
  }

  private setLinkStatus(text: string): void {
    ui.linkStatus.textContent = text;
  }

  // ---- Draft ----------------------------------------------------------------------------------

  private readonly onStorageChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== "session") return;
    this.dubbing.onStorageChanged(changes);
    const change = changes[pendingKey(this.tabId)];
    if (change && isPendingSelection(change.newValue)) this.processPending(change.newValue);
  };

  private processPending(pending: PendingSelection): void {
    if (this.tabClosed) return;
    void chrome.storage.session.remove(pendingKey(this.tabId));
    const decision = decidePending(this.draft, pending, this.currentLesson());
    switch (decision.action) {
      case "reject":
        this.setDraftStatus(
          decision.reason === "empty"
            ? "The selection was empty. Select transcript text, then choose “Send to MyDubb” again."
            : decision.reason === "too-long"
              ? "The selection is too long (over 100,000 characters). Select a shorter part."
              : "That selection came from a different lecture, so it was ignored.",
        );
        return;
      case "confirm":
        this.awaitingConfirm = pending;
        ui.confirm.hidden = false;
        ui.confirmKeep.focus();
        return;
      case "replace":
        this.acceptSelection(pending);
    }
  }

  private resolveConfirm(replace: boolean): void {
    const pending = this.awaitingConfirm;
    this.awaitingConfirm = null;
    ui.confirm.hidden = true;
    ui.transcript.focus();
    if (!pending) return;
    if (replace && belongsElsewhere(pending.lessonKey, this.currentLesson())) {
      this.setDraftStatus("That selection came from a different lecture, so it was ignored.");
    } else if (replace) this.acceptSelection(pending);
    else this.setDraftStatus("Kept your edited draft. The new selection was discarded.");
  }

  private acceptSelection(pending: PendingSelection): void {
    this.draft = draftFromSelection(pending, this.state?.lesson?.key ?? null);
    ui.transcript.value = this.draft.text;
    this.saveDraftNow();
    this.dubbing.transcriptChanged();
    const lines = pending.text.split("\n").length;
    this.setDraftStatus(`Selection received (${pending.text.length} characters, ${lines} line${lines === 1 ? "" : "s"}).`);
  }

  /** The lecture now shown; undefined until the tab has reported a state. */
  private currentLesson(): CurrentLesson {
    return this.state ? (this.state.lesson?.key ?? null) : undefined;
  }

  private onEdit(): void {
    const text = ui.transcript.value;
    this.draft = {
      lessonKey: this.draft?.lessonKey ?? this.state?.lesson?.key ?? null,
      text,
      baseline: this.draft?.baseline ?? "",
    };
    this.scheduleSave();
    this.dubbing.transcriptChanged();
  }

  private onClear(): void {
    this.discardDraft("Draft cleared.");
    ui.transcript.focus();
  }

  private discardDraft(message: string): void {
    const hadContent = !!this.draft?.text || this.awaitingConfirm !== null;
    this.draft = null;
    this.awaitingConfirm = null;
    ui.confirm.hidden = true;
    ui.transcript.value = "";
    this.dubbing.transcriptChanged();
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void chrome.storage.session.remove([draftKey(this.tabId), pendingKey(this.tabId)]);
    if (hadContent || message === "Draft cleared.") this.setDraftStatus(message);
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.saveDraftNow();
    }, SAVE_DEBOUNCE_MS);
  }

  private saveDraftNow(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.draft && this.draft.text !== "") {
      void chrome.storage.session.set({ [draftKey(this.tabId)]: this.draft });
    } else {
      void chrome.storage.session.remove(draftKey(this.tabId));
    }
  }

  private setDraftStatus(text: string): void {
    ui.draftStatus.textContent = text;
  }
}

/** Chrome's sign-in window. The browser-test build lets a test stand in for it (never in dist/). */
function launchAuthWindow(url: string): Promise<string | undefined> {
  if (__MYDUBB_E2E__) {
    const hook = (globalThis as { mydubbE2EAuthFlow?: (url: string) => Promise<string | undefined> })
      .mydubbE2EAuthFlow;
    if (hook) return hook(url);
  }
  return chrome.identity.launchWebAuthFlow({ url, interactive: true });
}

const tabId = parseTabId(location.search);
if (tabId === null) {
  ui.linkStatus.textContent =
    "This panel is not linked to a tab. On a Udemy lecture, select text and choose “Send to MyDubb”, or click the MyDubb toolbar button.";
  ui.transcript.disabled = true;
  ui.clear.disabled = true;
} else {
  void new Panel(tabId).start();
}
