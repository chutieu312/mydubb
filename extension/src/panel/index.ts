// Side panel for one tab (sidepanel.html?tabId=N). It talks only to the content script of that tab
// through a port, so commands can never reach another tab. The draft lives in
// chrome.storage.session (memory only); it is sent to MyDubb only when the user chooses Generate
// audio (panel/dubbing.ts). Nothing of the MyDubb account ever reaches the content script. The
// MyDubb audio plays in the offscreen document (panel/player.ts), so it outlives this panel.

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
import { PlayerLink } from "./player";

const NO_LECTURE_LINK =
  "No Udemy lecture is linked to this tab, so there are no video controls. You can still paste a transcript, generate and listen here.";
const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 15;
// Failed attempts in a row (on a finished page) after which nothing answers because the page has no
// content script: an ordinary web page. Before that the tab may be a lecture that has not
// attached its script yet, and Generate waits (see Dubbing: a job filed too early is dropped).
const ORDINARY_AFTER_FAILURES = 3;
// How long an open connection may stay without a page state before the panel says so.
const STATE_WAIT_MS = 5000;
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
  private stateTimer: number | null = null;
  private saveTimer: number | null = null;
  private tabClosed = false;
  // Known to be an ordinary page (no content script answered); cleared by any page state and when
  // the tab starts loading again. Neither this nor a state: the source is not known yet.
  private ordinary = false;
  private tabLoading = false;
  private state: PageState | null = null;
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
        linkPlayback: (lessonKey) => this.linkPlayback(lessonKey),
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

    try {
      this.tabLoading = (await chrome.tabs.get(this.tabId)).status === "loading";
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
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.clearStateTimer();
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
    this.receivedState = false;
    let port: chrome.runtime.Port;
    try {
      port = chrome.tabs.connect(this.tabId, { name: PANEL_PORT_NAME, frameId: 0 });
    } catch {
      this.onDisconnect();
      return;
    }
    this.port = port;
    // Only a Udemy page has a script to answer, so an open connection is a lecture page (or a
    // Udemy page that is not one) whose state is on its way: Generate waits for it. If it is slow,
    // the panel says so; it never turns the tab into an ordinary page meanwhile.
    this.clearStateTimer();
    this.stateTimer = window.setTimeout(() => {
      this.stateTimer = null;
      if (this.port === port && !this.receivedState) {
        this.setLinkStatus("The Udemy tab has not reported its page yet, so Generate is waiting. Reload the tab if this stays.");
      }
    }, STATE_WAIT_MS);
    port.onMessage.addListener((message: unknown) => {
      if (this.port !== port || !isContentToPanel(message)) return;
      if (message.type === "state") {
        const first = !this.receivedState;
        this.receivedState = true;
        this.clearStateTimer();
        this.retries = 0;
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
    this.clearStateTimer();
    this.port = null;
    this.state = null;
    this.renderVideo();
    if (this.tabClosed) return;
    if (hadState) {
      this.setLinkStatus("Connection to the Udemy tab was lost (reload or navigation). Reconnecting…");
    } else if (this.retries === 0 && !this.ordinary) {
      this.setLesson("Checking this tab…", "Looking for a Udemy lecture in this tab.");
      this.setLinkStatus("Looking for a Udemy lecture in this tab…");
    }
    // An ordinary web page has no content script, so nothing answers: that is not an error. A
    // lecture that has not attached its script yet looks the same for a moment, so the panel
    // decides only after several failed attempts on a finished page (or the last retry). Until
    // then Generate is unavailable; afterwards it works without a video, and keeps looking in case
    // the tab becomes a lecture (which then replaces the page's job and audio, as a changed lecture).
    const failures = this.retries + 1;
    if (!this.ordinary && ((failures >= ORDINARY_AFTER_FAILURES && !this.tabLoading) || failures > MAX_RETRIES)) {
      this.ordinary = true;
      this.setLesson("Not a Udemy lecture", "This tab shows no Udemy lecture.");
      this.setLinkStatus(NO_LECTURE_LINK);
      this.dubbing.lessonState(null);
    } else {
      this.dubbing.sourceChanged();
    }
    if (this.retries >= MAX_RETRIES) {
      if (hadState) {
        this.setLesson("Not a Udemy lecture", "This tab shows no Udemy lecture.");
        this.setLinkStatus("Could not reach the Udemy tab. Reload the lecture tab, then click Reconnect.");
        ui.reconnect.hidden = false;
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
      this.tabLoading = true;
      if (this.port) this.setLinkStatus("The Udemy tab is loading…");
      // A new page is loading in this tab: what it shows is not known until it has finished.
      if (this.ordinary) {
        this.ordinary = false;
        this.dubbing.sourceChanged();
      }
    }
    if (change.status === "complete") {
      this.tabLoading = false;
      if (!this.port) this.connect(true);
    }
  };

  private clearStateTimer(): void {
    if (this.stateTimer !== null) window.clearTimeout(this.stateTimer);
    this.stateTimer = null;
  }

  private markTabClosed(): void {
    this.tabClosed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearStateTimer();
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
    this.ordinary = false; // the state says what the tab shows

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

  /** Over the tab port: the page links itself to the playback session of this lecture. */
  private linkPlayback(lessonKey: string): void {
    const message: PlaybackLinkMessage = { type: "playback-link", lessonKey };
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
    this.setDraftStatus(`Selection received (${pending.text.length} characters, ${lines} line${lines === 1 ? "" : "s"}).`);
  }

  /**
   * The lecture now shown; null for a tab that shows none; undefined while that is not known (the
   * tab has not reported a state and is not yet known to be an ordinary page).
   */
  private currentLesson(): CurrentLesson {
    if (this.state) return this.state.lesson?.key ?? null;
    return this.ordinary ? null : undefined;
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
  ui.linkStatus.textContent =
    "This panel is not linked to a tab. On a page, select text and choose “Send to MyDubb”, or click the MyDubb toolbar button.";
  ui.transcript.disabled = true;
  ui.clear.disabled = true;
} else {
  void new Panel(tabId).start();
}
