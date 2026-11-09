// Side panel for one tab (sidepanel.html?tabId=N). It talks only to the content script of that tab
// through a port, so commands can never reach another tab. On an ordinary page that content script
// is injected (chrome.scripting) while the user's click on the MyDubb button or "Send to MyDubb"
// gives access to the page (activeTab): by the service worker at the click, and again here after
// the page reloads (the access stays on the same origin; another origin needs a new click). The
// draft lives in chrome.storage.session (memory only); it is sent to MyDubb only when the user chooses Generate
// audio (panel/dubbing.ts). Nothing of the MyDubb account ever reaches the content script. The
// MyDubb audio plays in the offscreen document (panel/player.ts), so it outlives this panel.

import {
  PANEL_PORT_NAME,
  draftKey,
  isContentToPanel,
  isDraftRecord,
  isPageInjected,
  isPendingSelection,
  pendingKey,
  type CommandError,
  type CommandMessage,
  type CommandResult,
  type DraftRecord,
  type PageState,
  type PendingSelection,
} from "../shared/messages";
import { AUDIO_CHANNEL, OFFSCREEN_PAGE, PLAYER_PANEL_PORT, type PlaybackLinkMessage } from "../shared/playback";
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
import type { PageAccess } from "./pageSync";
import { PlayerLink } from "./player";

const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 15;
const SAVE_DEBOUNCE_MS = 250;
const SEEK_SECONDS = 5;
// How long a "place" command may wait for the tab's answer (the page itself waits up to 10 s).
const PLACE_TIMEOUT_MS = 12_000;

const COMMAND_ERRORS: Record<CommandError, string> = {
  "no-video": "No lecture video is attached.",
  stale: "The lecture or video changed before the command ran, so nothing was done. Check the panel and try again.",
  "not-ready": "The video is not ready yet. Wait for it to load.",
  "not-seekable": "The video cannot be seeked yet.",
  "out-of-range": "That time is outside the video.",
  "seek-failed": "The video did not reach that time.",
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
  lessonDetail: byId("lesson-detail"),
  linkStatus: byId("link-status"),
  linkDetail: byId("link-detail"),
  lessonBox: byId("lesson-box"),
  lectureRows: ["lesson-term", "lesson-detail", "link-term", "link-detail"].map((id) => byId(id)),
  reconnect: byId<HTMLButtonElement>("reconnect"),
  transcript: byId<HTMLTextAreaElement>("transcript"),
  clear: byId<HTMLButtonElement>("clear"),
  draftStatus: byId("draft-status"),
  confirm: byId("confirm"),
  confirmReplace: byId<HTMLButtonElement>("confirm-replace"),
  confirmKeep: byId<HTMLButtonElement>("confirm-keep"),
  videoBox: byId("video-box"),
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
  // Whether MyDubb can reach the tab's page (ordinary pages: the content script could be injected).
  private access: PageAccess = "unknown";
  // The last state the tab reported was an ordinary page's.
  private wasWeb = false;
  private draft: DraftRecord | null = null;
  private awaitingConfirm: PendingSelection | null = null;
  private nextRequestId = 1;
  // "place" commands waiting for the page's answer, by request id.
  private readonly placing = new Map<number, (result: CommandResult) => void>();
  private readonly cleanup = new AbortController();
  private readonly dubbing: Dubbing;
  private readonly audioChannel = new BroadcastChannel(AUDIO_CHANNEL);

  constructor(private readonly tabId: number) {
    const player = new PlayerLink({
      tabId,
      hasDocument: () => chrome.offscreen.hasDocument(),
      createDocument: () => createOffscreenDocument(),
      connect: () => chrome.runtime.connect({ name: PLAYER_PANEL_PORT }),
      sendAudio: (transferId, blob) => this.audioChannel.postMessage({ transferId, blob }),
      randomId: () => crypto.randomUUID(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
    });
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
        player,
      },
      {
        currentLesson: () => this.currentLesson(),
        transcript: () => ui.transcript.value,
        linkPlayback: (lessonKey, page, video) => this.linkPlayback(lessonKey, page, video),
        pageVideo: () => ({
          access: this.access,
          page: this.port && this.state ? this.state.page : null,
          video: this.port && this.state ? this.state.video : null,
        }),
        placeVideo: (lessonKey, at) => this.placeVideo(lessonKey, at),
      },
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
    chrome.runtime.onMessage.addListener(this.onRuntimeMessage);

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
    // The stored form, account and job first: a selection or page state arriving now must not be
    // overwritten by that older snapshot (Dubbing also holds anything that arrives meanwhile).
    await this.dubbing.restore();
    this.connect(true);
    // A panel opened (or reopened) on an ordinary page: the content script is put there if the
    // user's click allowed it (on Udemy it is already there and nothing changes).
    void this.injectPage();
    const pending = stored[pendingKey(this.tabId)];
    if (isPendingSelection(pending)) this.processPending(pending);
    await this.dubbing.loadRemote();
  }

  private dispose(): void {
    this.cleanup.abort();
    // Stops following the job and releases the audio; the job itself keeps running on MyDubb.
    this.dubbing.dispose();
    chrome.storage.onChanged.removeListener(this.onStorageChanged);
    chrome.tabs.onRemoved.removeListener(this.onTabRemoved);
    chrome.tabs.onUpdated.removeListener(this.onTabUpdated);
    chrome.runtime.onMessage.removeListener(this.onRuntimeMessage);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveDraftNow();
    }
    this.port?.disconnect();
    this.port = null;
    this.audioChannel.close();
  }

  // ---- Connection to the tab ----------------------------------------------------------------

  private connect(resetRetries: boolean): void {
    if (this.tabClosed || this.port) return;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (resetRetries) this.retries = 0;
    ui.reconnect.hidden = true;
    this.renderLessonBox();
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
        const first = !this.receivedState;
        this.receivedState = true;
        this.retries = 0;
        this.access = "granted";
        this.applyState(message.state);
        if (first) this.dubbing.pageConnected();
      } else {
        const placed = this.placing.get(message.requestId);
        if (placed) placed(message);
        else this.applyResult(message);
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (this.port === port) this.onDisconnect();
    });
  }

  private onDisconnect(): void {
    for (const answer of [...this.placing.values()]) answer({ type: "result", requestId: -1, ok: false, error: "no-video" });
    const hadState = this.receivedState;
    this.port = null;
    this.state = null;
    this.renderVideo();
    this.dubbing.pageChanged();
    if (this.tabClosed) return;
    if (hadState) {
      this.setLinkStatus("Connection to the Udemy tab was lost (reload or navigation). Reconnecting…");
    }
    // An ordinary web page has no content script, so nothing answers: that is not an error and
    // nothing is said about it. The panel works there without a video; it keeps looking in case the
    // tab becomes a lecture.
    if (this.retries >= MAX_RETRIES) {
      // An ordinary page needs the user's click again to be reached: said where Sync is offered.
      if (hadState && !this.wasWeb) {
        this.setLesson("Video controls unavailable", "The lecture's video controls could not be reached.");
        this.setLinkStatus("Could not reach the video controls of this tab. Reload the tab, then click Reconnect.");
        ui.reconnect.hidden = false;
        this.renderLessonBox();
      }
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
    if (change.status === "loading") {
      // Another page is loading in this tab: a result made before it was not made on that page.
      this.dubbing.pageNavigated();
      if (this.port) this.setLinkStatus("The Udemy tab is loading…");
      // An ordinary page's access may not carry over (another origin): known again once loaded.
      if (this.wasWeb) this.access = "unknown";
    }
    if (change.status === "complete") {
      if (!this.port) this.connect(true);
      void this.injectPage();
    }
  };

  /** The service worker injected the content script after the user's click: connect to it now. */
  private readonly onRuntimeMessage = (message: unknown, sender: chrome.runtime.MessageSender): void => {
    if (sender.id !== chrome.runtime.id || sender.tab || !isPageInjected(message) || message.tabId !== this.tabId) return;
    this.access = "granted";
    if (!this.port) this.connect(true);
    this.dubbing.pageChanged();
  };

  /**
   * Puts the content script into the tab's top frame when the access from the user's click allows
   * it (the injected script does nothing if it is already there). Refused: MyDubb cannot reach the
   * page (another origin since the click, a browser page); listening is not affected.
   */
  private async injectPage(): Promise<void> {
    if (this.tabClosed) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: this.tabId, frameIds: [0] }, files: ["content.js"] });
    } catch {
      if (!this.receivedState || !this.port) this.access = "none";
      this.dubbing.pageChanged();
      return;
    }
    this.access = "granted";
    if (!this.port) this.connect(true);
    this.dubbing.pageChanged();
  }

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
    this.setLesson("—", "—");
    this.setLinkStatus("The linked tab was closed. Open a page and send a selection to start again.");
    this.renderVideo();
    this.dubbing.tabClosed();
  }

  // ---- Page state -----------------------------------------------------------------------------

  private applyState(next: PageState): void {
    const previous = this.state;
    const prevKey = previous?.lesson?.key ?? null;
    const nextKey = next.lesson?.key ?? null;
    this.state = next;
    this.wasWeb = next.page !== null;

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
      this.setLinkStatus("The video player was replaced. Controls now follow the new video.", true);
    } else if (!previous) {
      this.setLinkStatus(next.lesson ? "Connected to the lecture tab." : "This tab is not a Udemy lecture page.", true);
    }
    ui.reconnect.hidden = true;
    if (next.lesson) {
      const title = next.lesson.title || "Untitled lecture";
      this.setLesson(shortTitle(title), `${title} (lecture ${next.lesson.lectureId})`);
    } else {
      this.setLesson("Not a Udemy lecture page", "Not a Udemy lecture page");
    }
    this.renderVideo();
    // After the draft decision above, so the form and the job follow the same lecture rule.
    this.dubbing.lessonState(nextKey);
  }

  private renderVideo(): void {
    const video = this.state?.video;
    const connected = this.port !== null && this.state !== null;
    // The video controls exist only for a Udemy lecture the tab reported: nowhere else is there a
    // video MyDubb can control, so nothing is offered.
    ui.videoBox.hidden = !(connected && this.state?.lesson);
    this.renderLessonBox();
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

  /**
   * What the tab is linked to is told only once a Udemy lecture is connected (the same rule as the
   * Video box), or when that link could not be restored; on any other page the panel starts with
   * the transcript and says nothing about lectures.
   */
  private renderLessonBox(): void {
    const show = (this.port !== null && !!this.state?.lesson) || !ui.reconnect.hidden || this.tabClosed;
    ui.lessonBox.hidden = !show;
    for (const row of ui.lectureRows) row.hidden = !show;
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

  /**
   * Pauses the lecture video at `at` seconds (where a newly loaded audio starts). Resolves with
   * null once the page did it, or with why it did not: never reported as done otherwise.
   */
  private placeVideo(lessonKey: string, at: number): Promise<string | null> {
    const port = this.port;
    const video = this.state?.video;
    if (!port || this.state?.lesson?.key !== lessonKey) return Promise.resolve("The Udemy tab is not connected to this lecture.");
    if (video?.status !== "ready") return Promise.resolve(COMMAND_ERRORS["not-ready"]);
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      const done = (text: string | null) => {
        window.clearTimeout(timer);
        this.placing.delete(requestId);
        resolve(text);
      };
      const timer = window.setTimeout(() => done("The Udemy tab did not answer."), PLACE_TIMEOUT_MS);
      this.placing.set(requestId, (result) => done(result.ok ? null : (COMMAND_ERRORS[result.error ?? "invalid"] ?? COMMAND_ERRORS.invalid)));
      const message: CommandMessage = { type: "command", requestId, command: "place", at, lessonKey, videoId: video.id };
      try {
        port.postMessage(message);
      } catch {
        done("The Udemy tab is not connected.");
      }
    });
  }

  /** Over the tab port: the page links itself to the playback session of this lecture (or page). */
  private linkPlayback(lessonKey: string, page?: string, video?: string): void {
    const message: PlaybackLinkMessage =
      page === undefined ? { type: "playback-link", lessonKey } : { type: "playback-link", lessonKey, page, ...(video ? { video } : {}) };
    try {
      this.port?.postMessage(message);
    } catch {
      // Not connected: linked again when the port reconnects (pageConnected).
    }
  }

  private applyResult(result: CommandResult): void {
    if (!result.ok) this.setVideoError(COMMAND_ERRORS[result.error ?? "invalid"] ?? COMMAND_ERRORS.invalid);
  }

  private setVideoError(text: string): void {
    ui.videoError.textContent = text;
  }

  /** The state of the link to the tab: shown in the header, or only under Details when all is well (`quiet`). */
  private setLinkStatus(text: string, quiet = false): void {
    ui.linkStatus.textContent = quiet ? "" : text;
    ui.linkDetail.textContent = quiet ? text : "See the message above.";
  }

  private setLesson(short: string, full: string): void {
    ui.lessonLabel.textContent = short;
    ui.lessonLabel.title = full;
    ui.lessonDetail.textContent = full;
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
    let status = `Selection received (${pending.text.length} characters, ${lines} line${lines === 1 ? "" : "s"}).`;
    if (pending.captionLines === "restored") {
      status +=
        " Chrome sent it without line breaks, so each caption timestamp was put back on its own line." +
        " Check that every time on a line of its own is a caption start, not a time that was said.";
    } else if (pending.captionLines === "kept") {
      status +=
        " Chrome sent it without line breaks, and its timestamps could not be told apart from the spoken words with" +
        " certainty, so it is kept as sent. To use caption times, copy the selection on the page (Ctrl+C) and paste" +
        " it here (Ctrl+V).";
    }
    this.setDraftStatus(status);
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

/** The offscreen document that plays the MyDubb audio; another panel may be creating it too. */
async function createOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PAGE,
      // AUDIO_PLAYBACK: it plays the audio. BLOBS: it keeps the MP3 Blob and its object URL while
      // playback is paused (an AUDIO_PLAYBACK-only document is closed after 30 s of silence).
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.BLOBS],
      justification: "Plays the MyDubb audio of a lecture tab while its side panel is closed.",
    });
  } catch (error) {
    if (!(await chrome.offscreen.hasDocument())) throw error;
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

/**
 * A Udemy page title without the site part and Udemy's "Course: " prefix
 * ("Course: Name | Udemy" -> "Name"; "Lecture | Course | Udemy" -> "Lecture").
 */
function shortTitle(title: string): string {
  const first = (title.split(" | ")[0] ?? "").replace(/^Course:\s*/i, "").trim();
  return first || title;
}

const tabId = parseTabId(location.search);
if (tabId === null) {
  ui.lessonBox.hidden = false; // the one thing this panel can say
  ui.linkStatus.textContent =
    "This panel is not linked to a tab. On a page, select text and choose “Send to MyDubb”, or click the MyDubb toolbar button.";
  ui.transcript.disabled = true;
  ui.clear.disabled = true;
} else {
  void new Panel(tabId).start();
}
