// The MyDubb half of the side panel: the account connection, the dubbing form, the job the tab
// follows and the controls of the tab's playback session (the audio itself plays in the offscreen
// document, see player.ts, so it carries on when the panel closes). The rules for the form and the request are the website's own
// modules (frontend/src/lib), imported rather than copied, so both send the same request for the
// same input. Text from the page, the user or the server is only ever set as textContent.
//
// Everything that comes back asynchronously is checked against the identity it was sent for
// (account connection, lecture, Generate click) before it may change the panel: a late answer
// for another account, another lecture or an older click is dropped.

import type { AppMeta, Job, JobResult, TargetLanguageOption, VoiceOption } from "../../../frontend/src/api/types";
import { buildJobRequest, captionKey, fieldsFromCaptions, usesTimestamps } from "../../../frontend/src/lib/jobRequest";
import { VIETNAMESE, jobLanguage, languageChoiceOf } from "../../../frontend/src/lib/languages";
import { azureDisclosureShort } from "../../../frontend/src/lib/providers";
import {
  AUDIO_SPEEDS,
  DEFAULT_SPEED,
  formatClock,
  formatOutputDuration,
  previewOutputSeconds,
  speedLabel,
} from "../../../frontend/src/lib/speed";
import { editTimestamp } from "../../../frontend/src/lib/timestampInput";
import { formatSeconds, parseTimestamp, previewTargetDuration } from "../../../frontend/src/lib/timestamps";
import { analyzeTranscriptTiming, captionClock, type TranscriptTiming } from "../../../frontend/src/lib/transcriptTiming";
import { formKey, jobKey, loadedKey } from "../shared/messages";
import { PLAYER_SEEK_SECONDS, sourceRangeOf, type PanelPlayerView, type PlaybackProblem } from "../shared/playback";
import { clockLabel, isSyncSource, syncNoticeText, syncPreviewText, syncStatusText, type SyncSource } from "../shared/sync";
import { MyDubbError, NO_ANSWER, type MyDubbApi } from "./api";
import { AUTH_KEY, connect, connectErrorMessage, isLive, isStoredAuth, type StoredAuth } from "./auth";
import { formatTime, type CurrentLesson } from "./draft";
import {
  ACTIVE_STATUSES,
  SEND_TIMEOUT_MS,
  STATUS_TEXT,
  UNKNOWN_OUTCOME,
  failedJobMessage,
  isJobRecord,
  jobErrorMessage,
  pollJob,
  recordBelongs,
  sleep,
  type JobChoices,
  type JobRecord,
} from "./jobs";
import type { PanelPlayer } from "./player";

/** The form fields of a tab, kept with the lecture they were filled for. */
export interface FormRecord {
  lessonKey: string | null;
  firstStart: string;
  lastStart: string;
  ignoreTimestamps: boolean;
  targetLanguage: string;
  voice: string;
  speed: number;
  // The caption pair the two time fields were last filled from (filled once per pair).
  filledFrom: string | null;
}

const EMPTY_FORM: FormRecord = {
  lessonKey: null,
  firstStart: "",
  lastStart: "",
  ignoreTimestamps: false,
  targetLanguage: "",
  voice: "",
  speed: DEFAULT_SPEED,
  filledFrom: null,
};

export function isFormRecord(value: unknown): value is FormRecord {
  const v = value as Partial<FormRecord> | null;
  const short = (s: unknown) => typeof s === "string" && s.length <= 100;
  return (
    typeof v === "object" &&
    v !== null &&
    (v.lessonKey === null || (typeof v.lessonKey === "string" && v.lessonKey.length <= 250)) &&
    short(v.firstStart) &&
    short(v.lastStart) &&
    typeof v.ignoreTimestamps === "boolean" &&
    short(v.targetLanguage) &&
    short(v.voice) &&
    typeof v.speed === "number" &&
    (v.filledFrom === null || short(v.filledFrom))
  );
}

// A field the server can refuse: where its message goes and the control to focus, in form order.
const FIELDS: Record<string, { error: string; input: string }> = {
  transcript: { error: "transcript-error", input: "transcript" },
  first_sentence_start: { error: "first-start-error", input: "first-start" },
  last_sentence_start: { error: "last-start-error", input: "last-start" },
  target_language: { error: "target-language-error", input: "target-language" },
  voice: { error: "voice-error", input: "voice" },
  speed: { error: "speed-error", input: "speed" },
};
const SAVE_DEBOUNCE_MS = 250;
const LESSON_CHANGED =
  "The lecture changed. A job already sent keeps running on MyDubb, but its result is not shown under this lecture.";
const ACCOUNT_CHANGED = "The MyDubb account changed, so the previous job and result were cleared from this panel.";
const CONNECTION_ENDED = "Your MyDubb connection ended (expired or disconnected). Connect again to continue.";
const AUDIO_READY = "Ready. Press play when you want to listen.";
const PLAYER_PROBLEMS: Record<PlaybackProblem, string> = {
  "play-blocked": "Chrome blocked playback. Press Play again.",
  "play-failed": "The audio could not start playing. Press Play to try again, or Load audio.",
  "media-error": "The audio could not be played. Choose Load audio to try again.",
  "not-linked":
    "The Udemy tab is not linked to the player yet. If this stays, reload the lecture tab, then choose Load audio.",
};

type Storage = Pick<chrome.storage.StorageArea, "get" | "set" | "remove">;

/**
 * The source span of one Generate click, for Sync with video: plain mode, the two start times of
 * the request; timed mode, the first and last caption (milliseconds kept), with the baseline of the
 * two fields, which the user may have changed (then the video rate differs from the speed).
 * Undefined when the click's input gives none.
 */
export function syncSourceFor(
  timing: TranscriptTiming,
  timed: boolean,
  firstStart: string,
  lastStart: string,
  speed: number,
): SyncSource | undefined {
  const first = parseTimestamp(firstStart);
  const last = parseTimestamp(lastStart);
  if (first === null || last === null || last <= first) return undefined;
  const baseline = last - first;
  let source: SyncSource | null = null;
  if (!timed) source = { mode: "plain", start: first, end: last, baseline, speed };
  else if (timing.kind === "timed") source = { mode: "timed", start: timing.first, end: timing.last, baseline, speed };
  return source && isSyncSource(source) ? source : undefined;
}

/**
 * The click's span, kept only when the server's result agrees with it (baseline, speed and, for
 * timed jobs, the caption span it used); otherwise null, and Sync stays unavailable.
 */
export function confirmedSync(source: SyncSource | undefined, result: JobResult): SyncSource | null {
  if (!source) return null;
  if (Math.abs(result.baseline_duration_seconds - source.baseline) > 0.001 || Math.abs(result.speed - source.speed) > 1e-9) {
    return null;
  }
  const timing = result.timing ?? null;
  if (source.mode === "plain") return timing === null ? source : null;
  if (
    timing &&
    (Math.abs(timing.source_first_seconds - source.start) > 0.0015 || Math.abs(timing.source_last_seconds - source.end) > 0.0015)
  ) {
    return null;
  }
  return source;
}

export interface DubbingDeps {
  tabId: number;
  origin: string;
  extensionId: string;
  api: MyDubbApi;
  storage: Storage;
  launchWebAuthFlow(url: string): Promise<string | undefined>;
  randomId(): string;
  now(): number;
  /** The tab's playback session in the offscreen document. */
  player: PanelPlayer;
}

export interface DubbingHost {
  /** The lecture now shown in the tab; undefined until the tab reported a state. */
  currentLesson(): CurrentLesson;
  /** The transcript as the panel's text box holds it. */
  transcript(): string;
  /** Asks the tab's content script to link its page to the playback session of that lecture. */
  linkPlayback(lessonKey: string): void;
  /** Pauses the lecture video at `at` seconds; null once done, otherwise why it was not done. */
  placeVideo(lessonKey: string, at: number): Promise<string | null>;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function dubbingUi() {
  return {
    accountStatus: byId("account-status"),
    accountDetail: byId("account-detail"),
    accountError: byId("account-error"),
    connect: byId<HTMLButtonElement>("connect"),
    disconnect: byId<HTMLButtonElement>("disconnect"),
    metaStatus: byId("meta-status"),
    metaRetry: byId<HTMLButtonElement>("meta-retry"),
    timing: byId("timing"),
    timingText: byId("timing-text"),
    timingOverride: byId("timing-override"),
    timingOverrideText: byId("timing-override-text"),
    useTranscriptTimes: byId<HTMLButtonElement>("use-transcript-times"),
    ignoreTimestamps: byId<HTMLInputElement>("ignore-timestamps"),
    firstStart: byId<HTMLInputElement>("first-start"),
    lastStart: byId<HTMLInputElement>("last-start"),
    language: byId<HTMLSelectElement>("target-language"),
    voice: byId<HTMLSelectElement>("voice"),
    speed: byId("speed"),
    lengthSummary: byId("length-summary"),
    lengthNote: byId("length-note"),
    timingNote: byId("timing-note"),
    disclosure: byId("disclosure"),
    formError: byId("form-error"),
    generate: byId<HTMLButtonElement>("generate"),
    generateHint: byId("generate-hint"),
    listenEmpty: byId("listen-empty"),
    listenNotice: byId("listen-notice"),
    resultSection: byId("result-section"),
    jobStatus: byId("job-status"),
    jobError: byId("job-error"),
    checkAgain: byId<HTMLButtonElement>("check-again"),
    jobChoices: byId("job-choices"),
    result: byId("result"),
    resultDetails: byId("result-details"),
    audioStatus: byId("audio-status"),
    playerSection: byId("player-section"),
    player: byId("player"),
    playerInfo: byId("player-info"),
    playerState: byId("player-state"),
    playerPlay: byId<HTMLButtonElement>("player-play"),
    playerBack: byId<HTMLButtonElement>("player-back"),
    playerForward: byId<HTMLButtonElement>("player-forward"),
    playerSeek: byId<HTMLInputElement>("player-seek"),
    playerCurrent: byId("player-current"),
    playerDuration: byId("player-duration"),
    playerProblem: byId("player-problem"),
    playerFloating: byId<HTMLButtonElement>("player-floating"),
    jobNote: byId("job-note"),
    videoPlace: byId("video-place"),
    playerLoad: byId<HTMLButtonElement>("player-load"),
    playerEmpty: byId("player-empty"),
    syncStatus: byId("sync-status"),
    syncToggle: byId<HTMLButtonElement>("sync-toggle"),
    syncConfirm: byId("sync-confirm"),
    syncPreview: byId("sync-preview"),
    syncOn: byId<HTMLButtonElement>("sync-on"),
    syncCancel: byId<HTMLButtonElement>("sync-cancel"),
    syncNotice: byId("sync-notice"),
    durations: byId("result-durations"),
    translationHeading: byId("translation-heading"),
    translation: byId("translation"),
    notices: byId("notices"),
  };
}

function setOptions(select: HTMLSelectElement, options: { value: string; label: string }[], value: string): void {
  select.replaceChildren(
    ...options.map((o) => {
      const option = document.createElement("option");
      option.value = o.value;
      option.textContent = o.label;
      return option;
    }),
  );
  select.value = value;
}

function addPair(list: HTMLElement, term: string, detail: string): void {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = detail;
  list.append(dt, dd);
}

/** One speed of the Audio speed group: a radio button drawn as a small button. */
function speedOption(speed: number): HTMLLabelElement {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "speed";
  input.value = String(speed);
  label.append(input, speedLabel(speed));
  return label;
}

/** "Vietnamese · Andrew · 1.5x", then the video source and the MP3 length of one audio. */
function renderAudioInfo(
  target: HTMLElement,
  choices: { languageLabel: string; voiceLabel: string; speed: number },
  sourceRange: string | undefined,
  mp3: string,
): void {
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `${choices.languageLabel} · ${choices.voiceLabel} · ${speedLabel(choices.speed)}`;
  const source = document.createElement("p");
  source.className = "source";
  const range = document.createElement("span");
  range.textContent = sourceRange ? `Video ${sourceRange}` : "Video source not recorded";
  const length = document.createElement("span");
  length.textContent = `MP3 ${mp3}`;
  source.append(range, " ", length);
  target.replaceChildren(meta, source);
}

/** A result's translation, kept with the audio it was made with. */
interface TranslationText {
  jobId: string;
  text: string;
  tag: string | null;
  dir: "ltr" | "rtl" | "auto";
}

function isTranslationText(value: unknown): value is TranslationText {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.jobId === "string" &&
    typeof v.text === "string" &&
    (v.tag === null || typeof v.tag === "string") &&
    (v.dir === "ltr" || v.dir === "rtl" || v.dir === "auto")
  );
}

export class Dubbing {
  private readonly ui = dubbingUi();
  private meta: AppMeta | null = null;
  private languages: TargetLanguageOption[] = [];
  private defaultLanguage = "";
  private voices: VoiceOption[] = [];
  private auth: StoredAuth | null = null;
  private connecting = false;
  // Bumped whenever the account connection or the lecture changes: older answers are dropped.
  private authGen = 0;
  private lessonGen = 0;
  private lastLesson: CurrentLesson = undefined;
  private form: FormRecord = { ...EMPTY_FORM };
  private record: JobRecord | null = null;
  // The Generate click whose request has not been answered yet (one at a time).
  private sendingOp: string | null = null;
  private poll: AbortController | null = null;
  // The audio of the job this panel shows (once its result arrived), and a load started by hand.
  private resultAudio: {
    path: string;
    record: JobRecord;
    sync: SyncSource | null;
    mp3Seconds: number | null;
    translation: TranslationText;
  } | null = null;
  // The translation of the audio last loaded into the player: an earlier result stays readable
  // while a newer one waits for Use new audio (also after the panel is reopened).
  private loaded: TranslationText | null = null;
  private audioLoad: AbortController | null = null;
  private loadingAudio = false;
  // The session the content script was last asked to link, and whether one was shown.
  private linkedFor: string | null = null;
  private hadSession = false;
  private seeking = false;
  // The explanation shown before Sync is turned on the first time.
  private confirmingSync = false;
  private saveTimer: number | null = null;
  private disposed = false;
  // Until the stored form, account and job are read (restore()), page states and transcript
  // changes are held and replayed afterwards, so the stored snapshot never overwrites them.
  private restored = false;
  private heldLesson: { key: string | null } | null = null;
  private heldTranscript = false;
  // Form edits made before restore(): the newer in-memory form then wins over the snapshot.
  private formEdits = 0;
  // Writes and removals of this tab's job record, one at a time, each checked when it runs.
  private jobStore: Promise<void> = Promise.resolve();
  private readonly cleanup = new AbortController();

  constructor(
    private readonly deps: DubbingDeps,
    private readonly host: DubbingHost,
  ) {}

  /** restore() then loadRemote(): what the panel does, in one call (used by tests). */
  async start(): Promise<void> {
    await this.restore();
    await this.loadRemote();
  }

  /** Wires the form and reads this tab's stored form, account and job (no network). */
  async restore(): Promise<void> {
    const signal = this.cleanup.signal;
    const ui = this.ui;
    ui.connect.addEventListener("click", () => void this.connectAccount(), { signal });
    ui.disconnect.addEventListener("click", () => void this.disconnectAccount(), { signal });
    ui.metaRetry.addEventListener("click", () => void this.loadMeta(), { signal });
    ui.generate.addEventListener("click", () => void this.generate(), { signal });
    ui.checkAgain.addEventListener("click", () => this.record && this.follow(this.record), { signal });
    ui.ignoreTimestamps.addEventListener("change", () => this.changeIgnore(ui.ignoreTimestamps.checked), { signal });
    ui.useTranscriptTimes.addEventListener("click", () => this.fillFromCaptions(this.timing(), true), { signal });
    for (const [input, field] of [
      [ui.firstStart, "firstStart"],
      [ui.lastStart, "lastStart"],
    ] as const) {
      input.addEventListener("input", (event) => this.editTime(input, field, event as InputEvent), { signal });
    }
    ui.language.addEventListener("change", () => this.update({ targetLanguage: ui.language.value }), { signal });
    ui.voice.addEventListener("change", () => this.update({ voice: ui.voice.value }), { signal });
    ui.speed.addEventListener("change", (event) => this.update({ speed: Number((event.target as HTMLInputElement).value) }), {
      signal,
    });
    this.wirePlayer(signal);
    ui.speed.replaceChildren(...AUDIO_SPEEDS.map(speedOption));

    const stored = await this.deps.storage.get([AUTH_KEY, formKey(this.deps.tabId), jobKey(this.deps.tabId), loadedKey(this.deps.tabId)]);
    if (this.disposed) return;
    const form = stored[formKey(this.deps.tabId)];
    if (isFormRecord(form) && this.formEdits === 0) this.form = form;
    this.applyAuth(stored[AUTH_KEY], false);
    const loaded = stored[loadedKey(this.deps.tabId)];
    if (isTranslationText(loaded)) this.loaded = loaded;
    const record = stored[jobKey(this.deps.tabId)];
    if (isJobRecord(record) && recordBelongs(record, this.account(), this.host.currentLesson())) {
      this.record = record;
      this.renderRecord();
      if (record.state === "created") {
        this.follow(record);
      } else this.showUnknownOutcome();
    } else if (isJobRecord(record)) {
      void this.forgetRecord(record.operationId);
    } else if (record !== undefined) {
      void this.deps.storage.remove(jobKey(this.deps.tabId));
    }
    this.restored = true;
    this.deps.player.subscribe(() => this.checkPlayer());
    // What happened while reading, in order: the lecture rule first, then the transcript.
    const held = this.heldLesson;
    this.heldLesson = null;
    if (held) this.lessonState(held.key);
    if (this.heldTranscript) {
      this.heldTranscript = false;
      this.transcriptChanged();
    } else {
      this.renderForm();
    }
  }

  /** Checks the stored token with the server and loads the options (languages, voices). */
  async loadRemote(): Promise<void> {
    void this.verifyAuth();
    await this.loadMeta();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanup.abort();
    this.poll?.abort();
    this.poll = null;
    this.audioLoad?.abort();
    // Only the link: the playback session and its audio carry on without the panel.
    this.deps.player.dispose();
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveFormNow();
    }
  }

  // ---- Calls from the panel ------------------------------------------------------------------

  onStorageChanged(changes: Record<string, chrome.storage.StorageChange>): void {
    const change = changes[AUTH_KEY];
    if (change) this.applyAuth(change.newValue, true);
  }

  /** Every page state: forget what belongs to another lecture. */
  lessonState(key: string | null): void {
    if (!this.restored) {
      this.heldLesson = { key };
      return;
    }
    if (key !== this.lastLesson) {
      if (this.lastLesson !== undefined) this.lessonGen += 1;
      this.lastLesson = key;
    }
    if (this.record && !recordBelongs(this.record, this.account(), key)) {
      this.dropJob(LESSON_CHANGED);
    }
    this.checkPlayer();
    if (this.form.lessonKey !== key) {
      // The times belong to the transcript of one lecture; the language, voice and speed stay.
      if (this.form.lessonKey !== null) {
        this.form = { ...this.form, firstStart: "", lastStart: "", filledFrom: null, ignoreTimestamps: false };
      }
      this.form = { ...this.form, lessonKey: key };
      this.scheduleSave();
      this.renderForm();
    }
  }

  transcriptChanged(): void {
    if (!this.restored) {
      this.heldTranscript = true;
      return;
    }
    if (!this.form.ignoreTimestamps) this.fillFromCaptions(this.timing());
    this.renderForm();
  }

  tabClosed(): void {
    this.dropJob(null);
    this.ui.generate.disabled = true;
  }

  // ---- Account -------------------------------------------------------------------------------

  private account(): { userId: string; connectionId: string } | null {
    return this.auth ? { userId: this.auth.user.id, connectionId: this.auth.connectionId } : null;
  }

  private applyAuth(value: unknown, fromChange: boolean): void {
    const next = isStoredAuth(value) && isLive(value, this.deps.now()) ? value : null;
    if (next && this.auth && next.connectionId === this.auth.connectionId) {
      this.auth = next;
      this.renderAccount();
      return;
    }
    if (!next && !this.auth) {
      this.renderAccount();
      return;
    }
    const hadAuth = this.auth !== null;
    this.authGen += 1;
    this.auth = next;
    // Another account (or none): nothing of the previous one may stay on screen or keep playing.
    if (this.record) this.dropJob(fromChange && hadAuth ? ACCOUNT_CHANGED : null);
    if (hadAuth) this.deps.player.end();
    this.checkPlayer();
    this.setFieldErrors([]);
    this.ui.formError.textContent = "";
    if (next) this.ui.accountError.textContent = "";
    this.renderAccount();
  }

  /** A stored token the server no longer accepts is removed (once, for that connection). */
  private async verifyAuth(): Promise<void> {
    const auth = this.auth;
    if (!auth) return;
    try {
      await this.deps.api.session(auth.token);
    } catch (error) {
      if (error instanceof MyDubbError && error.isUnauthenticated) await this.expireAuth(auth);
    }
  }

  private async expireAuth(auth: StoredAuth): Promise<void> {
    // This panel first (the storage change below reaches it too, and then finds nothing to do).
    if (this.auth?.connectionId === auth.connectionId) {
      this.applyAuth(null, false);
      this.ui.accountError.textContent = CONNECTION_ENDED;
    }
    const stored = (await this.deps.storage.get(AUTH_KEY))[AUTH_KEY];
    if (isStoredAuth(stored) && stored.connectionId === auth.connectionId) {
      await this.deps.storage.remove(AUTH_KEY);
    }
  }

  private async connectAccount(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    this.ui.accountError.textContent = "";
    this.renderAccount();
    try {
      const auth = await connect({
        origin: this.deps.origin,
        extensionId: this.deps.extensionId,
        api: this.deps.api,
        launchWebAuthFlow: (url) => this.deps.launchWebAuthFlow(url),
        newConnectionId: () => this.deps.randomId(),
      });
      if (this.disposed) return;
      await this.deps.storage.set({ [AUTH_KEY]: auth });
      this.applyAuth(auth, true);
    } catch (error) {
      if (!this.disposed) this.ui.accountError.textContent = connectErrorMessage(error);
    } finally {
      this.connecting = false;
      if (!this.disposed) this.renderAccount();
    }
  }

  private async disconnectAccount(): Promise<void> {
    const auth = this.auth;
    if (!auth) return;
    // Every panel forgets the token first; then the server is asked to end it.
    await this.deps.storage.remove(AUTH_KEY);
    this.applyAuth(null, false);
    this.ui.accountStatus.textContent = "Disconnected";
    try {
      await this.deps.api.logout(auth.token);
    } catch {
      this.ui.accountError.textContent =
        "MyDubb could not be told to end the connection; it ends by itself when it expires.";
    }
  }

  private renderAccount(): void {
    const ui = this.ui;
    const auth = this.auth;
    ui.connect.hidden = auth !== null;
    ui.connect.disabled = this.connecting;
    ui.connect.textContent = this.connecting ? "Connecting…" : "Connect MyDubb";
    ui.disconnect.hidden = auth === null;
    if (auth) {
      const name = auth.user.display_name;
      ui.accountStatus.textContent = `Connected as ${name || auth.user.email}`;
      ui.accountStatus.title = auth.user.email;
      ui.accountDetail.textContent = name ? `${name} (${auth.user.email})` : auth.user.email;
    } else {
      ui.accountStatus.removeAttribute("title");
      ui.accountDetail.textContent =
        "MyDubb invitation accounts only; sign-in happens on mydubb.com.";
      if (this.connecting) ui.accountStatus.textContent = "Signing in…";
      else if (ui.accountStatus.textContent !== "Disconnected") ui.accountStatus.textContent = "Not connected";
    }
    this.renderGenerate();
  }

  // ---- Server options (GET /api/meta) --------------------------------------------------------

  private async loadMeta(): Promise<void> {
    const ui = this.ui;
    ui.metaRetry.hidden = true;
    ui.metaStatus.textContent = "Loading MyDubb options…";
    try {
      const meta = await this.deps.api.meta();
      if (this.disposed) return;
      this.meta = meta;
      const choice = languageChoiceOf(meta);
      this.languages = choice.options;
      this.defaultLanguage = choice.defaultId;
      this.voices = Array.isArray(meta.voices) ? meta.voices : [];
      ui.metaStatus.textContent = "";
      ui.disclosure.textContent = meta.providers ? (azureDisclosureShort(meta.providers) ?? "") : "";
      // The server's lists, in its order (the first language is its default): nothing invented.
      setOptions(
        ui.language,
        this.languages.map((l) => ({ value: l.id, label: l.label })),
        this.selectedLanguage(),
      );
      ui.language.disabled = this.languages.length === 0;
      setOptions(
        ui.voice,
        this.voices.map((v) => ({ value: v.id, label: v.label })),
        this.selectedVoice(),
      );
      ui.voice.disabled = this.voices.length === 0;
    } catch {
      if (this.disposed) return;
      ui.metaStatus.textContent = "Could not load the MyDubb options (languages and voices).";
      ui.metaRetry.hidden = false;
    }
    this.renderForm();
  }

  // ---- Form ----------------------------------------------------------------------------------

  private timing(): TranscriptTiming {
    return analyzeTranscriptTiming(this.host.transcript());
  }

  private update(change: Partial<FormRecord>): void {
    if (!this.restored) this.formEdits += 1;
    this.form = { ...this.form, ...change };
    this.scheduleSave();
    this.renderForm();
  }

  /** Fill the two fields from the first and last caption once per detected pair. */
  private fillFromCaptions(timing: TranscriptTiming, force = false): void {
    const key = captionKey(timing);
    if (timing.kind !== "timed" || key === null || (!force && this.form.filledFrom === key)) return;
    const fields = fieldsFromCaptions(timing) ?? { first: "", last: "" };
    this.update({ filledFrom: key, firstStart: fields.first, lastStart: fields.last });
  }

  private changeIgnore(ignore: boolean): void {
    this.update({ ignoreTimestamps: ignore });
    if (!ignore) this.fillFromCaptions(this.timing());
  }

  private editTime(input: HTMLInputElement, field: "firstStart" | "lastStart", event: InputEvent): void {
    const result = editTimestamp({
      previous: this.form[field],
      next: input.value,
      caret: input.selectionStart ?? input.value.length,
      inputType: event.inputType ?? "",
      data: event.data ?? null,
    });
    if (input.value !== result.value) input.value = result.value;
    input.setSelectionRange(result.caret, result.caret);
    if (result.value !== this.form[field]) this.update({ [field]: result.value });
  }

  private selectedLanguage(): string {
    const wanted = this.form.targetLanguage;
    return this.languages.some((l) => l.id === wanted) ? wanted : this.defaultLanguage;
  }

  private selectedVoice(): string {
    const wanted = this.form.voice;
    return this.voices.some((v) => v.id === wanted) ? wanted : (this.voices[0]?.id ?? "");
  }

  private renderForm(): void {
    const ui = this.ui;
    const form = this.form;
    if (ui.firstStart.value !== form.firstStart) ui.firstStart.value = form.firstStart;
    if (ui.lastStart.value !== form.lastStart) ui.lastStart.value = form.lastStart;
    ui.ignoreTimestamps.checked = form.ignoreTimestamps;
    const speed = String(AUDIO_SPEEDS.includes(form.speed as never) ? form.speed : DEFAULT_SPEED);
    for (const input of ui.speed.querySelectorAll("input")) input.checked = input.value === speed;
    if (this.meta) {
      ui.language.value = this.selectedLanguage();
      ui.voice.value = this.selectedVoice();
    }
    this.renderTiming();
    this.renderLength();
    this.renderGenerate();
  }

  private renderTiming(): void {
    const ui = this.ui;
    const timing = this.timing();
    const ignore = this.form.ignoreTimestamps;
    ui.timing.hidden = timing.kind === "none";
    ui.timingOverride.hidden = true;
    ui.timingNote.hidden = true;
    ui.ignoreTimestamps.parentElement!.hidden = timing.kind === "cues";
    if (timing.kind === "none") return;
    if (timing.kind === "cues") {
      ui.timingText.textContent = "SRT/WebVTT timing is not used yet: processed as plain text with the two start times.";
      return;
    }
    if (timing.kind === "invalid") {
      ui.timingText.textContent = ignore
        ? "Timestamps ignored: processed as plain text."
        : `The timestamps cannot be used. ${timing.message} Fix them, or ignore them.`;
      return;
    }
    if (ignore) {
      ui.timingText.textContent = "Timestamps ignored: the audio is fitted to the two start times.";
      return;
    }
    const fields = fieldsFromCaptions(timing);
    ui.timingNote.hidden = false;
    ui.timingText.textContent =
      `Timestamps detected: ${timing.captions} captions from ${captionClock(timing.first)} to ${captionClock(timing.last)}. ` +
      (fields ? "Start times filled from the captions." : "They start in the same second: enter the start times.");
    if (fields && (this.form.firstStart !== fields.first || this.form.lastStart !== fields.last)) {
      const baseline = previewTargetDuration(this.form.firstStart, this.form.lastStart);
      ui.timingOverrideText.textContent = `You changed the start times${
        baseline !== null ? `: the caption timing is scaled to ${formatSeconds(baseline)}` : ""
      }.`;
      ui.timingOverride.hidden = false;
    }
  }

  private renderLength(): void {
    const baseline = previewTargetDuration(this.form.firstStart, this.form.lastStart);
    const speed = this.form.speed;
    if (baseline === null) {
      this.setLength("Expected audio length · enter both start times, the last after the first", "—");
      this.ui.lengthNote.textContent = "";
      return;
    }
    const output = formatClock(previewOutputSeconds(baseline, speed));
    const relation =
      speed === DEFAULT_SPEED
        ? "It matches the time between your two start times."
        : `At ${speedLabel(speed)} the audio is ${speed > DEFAULT_SPEED ? "shorter" : "longer"} than the time between the two start times.`;
    this.setLength(`Expected audio length · ${formatSeconds(baseline)} at 1x`, output);
    this.ui.lengthNote.textContent = `${relation} Estimate only; MyDubb calculates the final length.`;
  }

  private setLength(label: string, value: string): void {
    const text = document.createElement("span");
    text.textContent = label;
    const length = document.createElement("strong");
    length.textContent = value;
    this.ui.lengthSummary.replaceChildren(text, " ", length);
  }

  private renderGenerate(): void {
    const ui = this.ui;
    ui.generate.disabled = this.disposed || !this.meta || !this.auth || this.sendingOp !== null;
    ui.generate.textContent = this.sendingOp !== null ? "Sending…" : "Generate audio";
    ui.generateHint.textContent = this.auth
      ? "Nothing is sent to MyDubb until you choose Generate audio."
      : "Connect MyDubb (top of the panel) to generate audio.";
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.saveFormNow();
    }, SAVE_DEBOUNCE_MS);
  }

  private saveFormNow(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.deps.storage.set({ [formKey(this.deps.tabId)]: this.form });
  }

  /** Shows the server's field messages; returns the first refused control (form order), if any. */
  private setFieldErrors(fields: { field: string; message: string }[]): string | null {
    let first: string | null = null;
    for (const [name, ids] of Object.entries(FIELDS)) {
      const message = fields.find((f) => f.field === name)?.message ?? "";
      byId(ids.error).textContent = message;
      if (message) byId(ids.input).setAttribute("aria-invalid", "true");
      else byId(ids.input).removeAttribute("aria-invalid");
      if (message && first === null) first = ids.input;
    }
    return first;
  }

  // ---- Generate ------------------------------------------------------------------------------

  private async generate(): Promise<void> {
    const ui = this.ui;
    if (this.sendingOp !== null || !this.meta) return;
    const auth = this.auth;
    if (!auth) return;
    const lessonKey = this.host.currentLesson();
    const transcript = this.host.transcript();
    this.setFieldErrors([]);
    ui.formError.textContent = "";
    if (typeof lessonKey !== "string") {
      ui.formError.textContent = "Open the Udemy lecture this transcript belongs to, then try again.";
      return;
    }
    if (transcript.trim() === "") {
      ui.formError.textContent = "There is no transcript. Send a selection from the lecture first.";
      return;
    }

    // This click's own copy of the input: editing the form afterwards changes nothing here.
    const timing = analyzeTranscriptTiming(transcript);
    const targetLanguage = this.selectedLanguage();
    const voice = this.selectedVoice();
    const body = buildJobRequest(
      {
        transcript,
        firstStart: this.form.firstStart,
        lastStart: this.form.lastStart,
        voice,
        speed: this.form.speed,
        targetLanguage,
        ignoreTimestamps: this.form.ignoreTimestamps,
      },
      timing,
    );
    const timed = usesTimestamps(timing, this.form.ignoreTimestamps);
    const sync = syncSourceFor(timing, timed, body.first_sentence_start, body.last_sentence_start, body.speed);
    const choices: JobChoices = {
      languageLabel: (this.languages.find((l) => l.id === targetLanguage) ?? VIETNAMESE).label,
      voiceLabel: this.voices.find((v) => v.id === voice)?.label ?? voice,
      speed: body.speed,
      timed,
      firstStart: body.first_sentence_start,
      lastStart: body.last_sentence_start,
      ...(sync ? { sync } : {}),
    };
    const record: JobRecord = {
      operationId: this.deps.randomId(),
      userId: auth.user.id,
      connectionId: auth.connectionId,
      lessonKey,
      state: "sending",
      jobId: null,
      sentAt: this.deps.now(),
      choices,
    };
    // A new job replaces the one followed so far (which keeps running on the server). The audio
    // loaded for an earlier result keeps playing until the user switches to the new one.
    this.dropJob(null, false);
    this.record = record;
    this.sendingOp = record.operationId;
    ui.listenNotice.textContent = "";
    this.renderGenerate();
    this.renderRecord();
    this.setJobStatus("Sending to MyDubb…");
    const authGen = this.authGen;
    const lessonGen = this.lessonGen;
    const current = () =>
      !this.disposed &&
      authGen === this.authGen &&
      lessonGen === this.lessonGen &&
      this.record?.operationId === record.operationId;
    // Written before sending: if the panel closes before the answer, reopening it says that the
    // outcome is unknown instead of assuming that nothing was created.
    await this.saveRecord(record);
    if (!current()) {
      // The account or lecture changed while writing: nothing is sent for this click.
      if (this.sendingOp === record.operationId) this.sendingOp = null;
      this.renderGenerate();
      return;
    }

    let job: Job;
    try {
      job = await this.deps.api.createJob(auth.token, body, SEND_TIMEOUT_MS);
    } catch (error) {
      // Unlocked first, so a refused field or the button can take the focus.
      if (this.sendingOp === record.operationId) this.sendingOp = null;
      this.renderGenerate();
      if (current()) this.sendFailed(error, auth);
      return;
    } finally {
      // Only this click's own flag: a newer click (after an account change) keeps its own.
      if (this.sendingOp === record.operationId) this.sendingOp = null;
      this.renderGenerate();
    }
    if (!current()) return;
    const created: JobRecord = { ...record, state: "created", jobId: job.id };
    this.record = created;
    // The server accepted this click: its progress shows under Your audio (nothing plays by itself).
    this.jobAccepted();
    await this.saveRecord(created);
    // Checked again after the write: a newer click or a lecture/account change owns the panel now.
    if (!current()) return;
    this.showStatus(job);
    this.follow(created);
  }

  private sendFailed(error: unknown, auth: StoredAuth): void {
    if (error instanceof MyDubbError && NO_ANSWER.has(error.code)) {
      // Never sent again automatically: the job may exist.
      this.showUnknownOutcome();
      return;
    }
    // The server refused it: no job was created.
    void this.forgetRecord();
    this.record = null;
    this.renderRecord();
    if (error instanceof MyDubbError && error.isUnauthenticated) {
      void this.expireAuth(auth);
      return;
    }
    const field = error instanceof MyDubbError ? this.setFieldErrors(error.fields) : null;
    this.ui.formError.textContent = jobErrorMessage(error);
    this.focusField(field);
  }

  /** The accepted job's status is brought into view; focus stays on the form. */
  private jobAccepted(): void {
    this.ui.resultSection.scrollIntoView?.({ block: "nearest" });
    this.keepFocus();
  }

  /** A refused request: the field to fix gets focus (the chosen speed for the speed group). */
  private focusField(id: string | null): void {
    const target = id === "speed" ? this.ui.speed.querySelector("input:checked") : id ? document.getElementById(id) : null;
    if (target instanceof HTMLElement) target.focus();
    else this.keepFocus();
  }

  /** Chromium drops focus from a button it disables (Generate while sending): it goes back there. */
  private keepFocus(): void {
    const active = document.activeElement;
    if ((active === null || active === document.body) && !this.ui.generate.disabled) this.ui.generate.focus();
  }

  /**
   * No answer to a Generate click: said beside the form (the click's place), and the record stays
   * so a reopened panel says it again. Nothing is resent.
   */
  private showUnknownOutcome(): void {
    this.ui.formError.textContent = UNKNOWN_OUTCOME;
    this.setJobStatus("No answer from MyDubb: unknown whether this job was created.");
    this.setJobError("");
  }

  // ---- Following a job -----------------------------------------------------------------------

  private follow(record: JobRecord): void {
    const auth = this.auth;
    const jobId = record.jobId;
    // A stale record (an older click) must not stop or replace the polling of the current one.
    if (!auth || !jobId || this.record?.operationId !== record.operationId) return;
    this.poll?.abort();
    const controller = new AbortController();
    this.poll = controller;
    const authGen = this.authGen;
    const lessonGen = this.lessonGen;
    const current = () =>
      !controller.signal.aborted &&
      !this.disposed &&
      authGen === this.authGen &&
      lessonGen === this.lessonGen &&
      this.record?.operationId === record.operationId;
    this.ui.checkAgain.hidden = true;
    this.setJobError("");
    void pollJob({
      getJob: (signal) => this.deps.api.getJob(auth.token, jobId, signal),
      onUpdate: (job) => current() && this.showStatus(job),
      signal: controller.signal,
      sleep,
      now: this.deps.now,
    }).then(async (outcome) => {
      if (!current()) return;
      // The panel stopped watching this job (done, failed, gone, given up): no spinner whatever
      // the last status said. Check again starts it again with the next answer.
      this.ui.jobStatus.classList.remove("working");
      switch (outcome.kind) {
        case "aborted":
          return;
        case "unauthenticated":
          await this.expireAuth(auth);
          return;
        case "gone":
          void this.forgetRecord(record.operationId);
          this.setJobError("MyDubb no longer has this job.");
          return;
        case "gave-up":
          this.setJobError(
            outcome.reason === "time"
              ? "The job is still running after 30 minutes, so the panel stopped checking. Check again later."
              : `Stopped checking the job: ${jobErrorMessage(outcome.error)}`,
          );
          this.ui.checkAgain.hidden = false;
          return;
        case "terminal":
          if (outcome.job.status === "failed") {
            this.setJobError(failedJobMessage(outcome.job));
            return;
          }
          await this.loadResult(auth, record, controller.signal, current);
      }
    });
  }

  private showStatus(job: Job): void {
    this.setJobStatus(STATUS_TEXT[job.status] ?? `Status: ${job.status}`, ACTIVE_STATUSES.has(job.status));
  }

  /**
   * The job's status line. `working` puts a spinner beside it (a CSS class; the text stays the
   * whole message): only while the job is queued or being processed and the panel is watching it.
   */
  private setJobStatus(text: string, working = false): void {
    this.ui.jobStatus.textContent = text;
    this.ui.jobStatus.classList.toggle("working", working);
  }

  private async loadResult(auth: StoredAuth, record: JobRecord, signal: AbortSignal, current: () => boolean): Promise<void> {
    const jobId = record.jobId ?? "";
    let result: JobResult;
    try {
      result = await this.deps.api.getResult(auth.token, jobId, signal);
    } catch (error) {
      if (!current()) return;
      if (error instanceof MyDubbError && error.isUnauthenticated) return void this.expireAuth(auth);
      if (error instanceof MyDubbError && error.code === "result_expired") void this.forgetRecord();
      else this.ui.checkAgain.hidden = false;
      this.setJobError(jobErrorMessage(error));
      return;
    }
    if (!current()) return;
    this.renderResult(result);
    const language = jobLanguage(result, this.languages);
    this.resultAudio = {
      path: result.audio.url,
      record,
      sync: confirmedSync(record.choices.sync, result),
      mp3Seconds: result.audio.duration?.mp3_decoded_seconds ?? null,
      translation: { jobId, text: result.translation.text, tag: language.tag ?? null, dir: language.dir ?? "auto" },
    };
    // The tab may already have a session: this job's (panel reopened: kept as it is, position,
    // playback and Sync included) or an earlier result's (replaced once the new MP3 is here).
    await this.deps.player.ready();
    if (!current()) return;
    const view = this.sessionView();
    if (view?.owner.jobId === jobId) {
      this.rememberLoaded(this.resultAudio.translation);
      this.ui.audioStatus.textContent = AUDIO_READY;
      this.checkPlayer();
      return;
    }
    await this.loadAudio(auth, signal, current);
  }

  private renderRecord(): void {
    const ui = this.ui;
    const record = this.record;
    ui.resultSection.hidden = record === null;
    ui.jobChoices.replaceChildren();
    ui.result.hidden = true;
    ui.resultDetails.hidden = record === null;
    this.renderListen();
    if (!record) return;
    const c = record.choices;
    addPair(ui.jobChoices, "Translate to", c.languageLabel);
    addPair(ui.jobChoices, "Voice", c.voiceLabel);
    addPair(ui.jobChoices, "Speed", speedLabel(c.speed));
    addPair(ui.jobChoices, "Timing", c.timed ? "Timed (caption times)" : "Plain");
    addPair(ui.jobChoices, "Start times", `${c.firstStart} → ${c.lastStart}`);
  }

  private renderResult(result: JobResult): void {
    const ui = this.ui;
    ui.result.hidden = false;
    ui.durations.replaceChildren();
    addPair(ui.durations, "Language", result.target_language_label ?? jobLanguage(result, this.languages).label);
    addPair(ui.durations, "Baseline (1x)", formatClock(result.baseline_duration_seconds));
    addPair(ui.durations, `Planned at ${speedLabel(result.speed)}`, formatOutputDuration(result.output_duration_seconds));
    const measured = result.audio.duration;
    if (measured) addPair(ui.durations, "Final MP3 (decoded)", `${measured.mp3_decoded_seconds.toFixed(3)} s`);
    addPair(ui.durations, "Available until", new Date(result.expires_at).toLocaleTimeString());
    ui.notices.replaceChildren(
      ...result.notices.map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      }),
    );
  }

  // ---- Audio (the tab's playback session) ---------------------------------------------------

  /**
   * Downloads the shown result's MP3 with the token and opens it as the tab's session. An earlier
   * session stays usable during the download; the player replaces it only once the new MP3 has
   * arrived (and releases its Sync: video paused, mute and rate given back). The new audio starts
   * paused at its beginning, Sync OFF, and the video is paused where this result starts.
   */
  private async loadAudio(auth: StoredAuth, signal: AbortSignal, current: () => boolean): Promise<void> {
    const target = this.resultAudio;
    const lessonKey = target?.record.lessonKey ?? this.host.currentLesson();
    const sync = target?.sync ?? null;
    const jobId = target?.record.jobId;
    if (!target || !jobId || typeof lessonKey !== "string") return;
    const ui = this.ui;
    this.loadingAudio = true;
    this.renderPlayer();
    try {
      ui.audioStatus.textContent = "Loading the audio…";
      let blob: Blob;
      try {
        blob = await this.deps.api.getAudio(auth.token, target.path, signal);
      } catch (error) {
        if (!current()) return;
        if (error instanceof MyDubbError && error.isUnauthenticated) return void this.expireAuth(auth);
        ui.audioStatus.textContent = `The audio could not be loaded: ${jobErrorMessage(error)}`;
        ui.checkAgain.hidden = false;
        return;
      }
      if (!current()) return;
      const { operationId, choices } = target.record;
      const outcome = await this.deps.player.open(
        {
          lessonKey,
          owner: { userId: auth.user.id, connectionId: auth.connectionId, jobId, operationId },
          // What the job was made with (copied at Generate), never the form as it is now.
          choices: {
            languageLabel: choices.languageLabel,
            voiceLabel: choices.voiceLabel,
            speed: choices.speed,
            sourceRange: sourceRangeOf(choices.sync),
          },
          sync,
        },
        blob,
      );
      if (!current()) {
        // Opened for an account, lecture or click this panel no longer shows: not kept.
        if (outcome.ok) this.deps.player.end(outcome.sessionId);
        return;
      }
      if (!outcome.ok) {
        ui.audioStatus.textContent =
          outcome.reason === "revoked"
            ? CONNECTION_ENDED
            : "The audio player could not start. Choose Load audio to try again (no new job is created).";
        return;
      }
      this.rememberLoaded(target.translation);
      ui.audioStatus.textContent = AUDIO_READY;
      void this.placeVideo(target.record, lessonKey, current);
    } finally {
      this.loadingAudio = false;
      if (!this.disposed) this.checkPlayer();
    }
  }

  /**
   * Pauses the video where the loaded result starts: its own Generate snapshot (the Sync span's
   * start, else its first start time), never the form. Said only once the page confirmed it.
   */
  private async placeVideo(record: JobRecord, lessonKey: string, current: () => boolean): Promise<void> {
    const ui = this.ui;
    const at = record.choices.sync?.start ?? parseTimestamp(record.choices.firstStart);
    if (at === null) {
      ui.videoPlace.textContent = "The start of this audio was not recorded, so the video was not moved.";
      return;
    }
    const label = clockLabel(at);
    ui.videoPlace.textContent = `Moving the video to ${label}…`;
    const problem = await this.host.placeVideo(lessonKey, at);
    if (!current() || this.disposed) return;
    ui.videoPlace.textContent =
      problem === null
        ? `Video paused at ${label}, where this audio starts.`
        : `The video was not moved to ${label}: ${problem}`;
  }

  /** The translation of the audio now in the player, kept for this tab. */
  private rememberLoaded(text: TranslationText): void {
    if (this.loaded?.jobId === text.jobId && this.loaded.text === text.text) return;
    this.loaded = text;
    void this.deps.storage.set({ [loadedKey(this.deps.tabId)]: text });
  }

  /** Load audio: the same download again (and the video placed again), never a new job. */
  private loadByHand(): void {
    const auth = this.auth;
    const target = this.resultAudio;
    if (!auth || !target || this.audioLoad || this.loadingAudio) return;
    const controller = new AbortController();
    this.audioLoad = controller;
    const authGen = this.authGen;
    const lessonGen = this.lessonGen;
    const operationId = target.record.operationId;
    const current = () =>
      !controller.signal.aborted &&
      !this.disposed &&
      authGen === this.authGen &&
      lessonGen === this.lessonGen &&
      this.record?.operationId === operationId;
    void this.loadAudio(auth, controller.signal, current).finally(() => {
      if (this.audioLoad === controller) this.audioLoad = null;
      if (!this.disposed) this.renderPlayer();
    });
  }

  private wirePlayer(signal: AbortSignal): void {
    const ui = this.ui;
    const player = this.deps.player;
    const on = (target: HTMLElement, name: string, handler: () => void) => target.addEventListener(name, handler, { signal });
    on(ui.playerPlay, "click", () => {
      const view = this.sessionView();
      if (view) player.command({ command: view.paused || view.ended ? "play" : "pause" });
    });
    on(ui.playerBack, "click", () => player.command({ command: "seek-by", value: -PLAYER_SEEK_SECONDS }));
    on(ui.playerForward, "click", () => player.command({ command: "seek-by", value: PLAYER_SEEK_SECONDS }));
    on(ui.playerSeek, "input", () => {
      this.seeking = true;
      ui.playerCurrent.textContent = formatTime(Number(ui.playerSeek.value));
    });
    on(ui.playerSeek, "change", () => {
      this.seeking = false;
      player.command({ command: "seek-to", value: Number(ui.playerSeek.value) });
    });
    on(ui.playerFloating, "click", () => {
      const view = this.sessionView();
      if (view) player.setFloating(!view.floating);
    });
    on(ui.syncToggle, "click", () => {
      const sync = this.sessionView()?.sync;
      if (!sync) return;
      if (sync.status === "off" && !sync.confirmed) {
        this.confirmingSync = true;
        this.renderPlayer();
        ui.syncOn.focus();
      } else if (sync.status === "off") player.setSync(true);
      else if (sync.status !== "unavailable") player.setSync(false);
    });
    on(ui.syncOn, "click", () => {
      this.confirmingSync = false;
      player.setSync(true);
      this.renderPlayer();
      ui.syncToggle.focus();
    });
    on(ui.syncCancel, "click", () => {
      this.confirmingSync = false;
      this.renderPlayer();
      ui.syncToggle.focus();
    });
    on(ui.playerLoad, "click", () => this.loadByHand());
  }

  /** The tab's content port is (re)connected: a session not linked yet may be linked now. */
  pageConnected(): void {
    this.linkedFor = null;
    this.checkPlayer();
  }

  private sessionBelongs(view: PanelPlayerView): boolean {
    const auth = this.auth;
    const lesson = this.host.currentLesson();
    return (
      !!auth &&
      view.owner.userId === auth.user.id &&
      view.owner.connectionId === auth.connectionId &&
      (lesson === undefined || view.lessonKey === lesson)
    );
  }

  /** The tab's session, when it belongs to this account connection and lecture. */
  private sessionView(): PanelPlayerView | null {
    const view = this.deps.player.view;
    return view && this.sessionBelongs(view) ? view : null;
  }

  /** Every change of the session, account or lecture: end what is not ours, link what is. */
  private checkPlayer(): void {
    if (!this.restored || this.disposed) return;
    const view = this.deps.player.view;
    if (view && !this.sessionBelongs(view)) {
      this.deps.player.end(view.sessionId);
    } else if (view && !view.linked && this.linkedFor !== view.sessionId && this.host.currentLesson() === view.lessonKey) {
      this.linkedFor = view.sessionId;
      this.host.linkPlayback(view.lessonKey);
    }
    const shown = this.sessionView();
    if (this.hadSession && !shown && this.resultAudio && !this.loadingAudio) {
      this.ui.audioStatus.textContent =
        "The player was released (the Udemy tab reloaded, left the lecture or was closed). Choose Load audio to listen again.";
    }
    this.hadSession = shown !== null;
    this.renderPlayer();
  }

  private renderPlayer(): void {
    const ui = this.ui;
    const view = this.sessionView();
    const result = this.resultAudio;
    ui.playerSection.hidden = !view && !result;
    ui.player.hidden = !view;
    ui.playerEmpty.hidden = !!view;
    if (view) {
      const playing = !view.paused && !view.ended;
      const ready = view.status === "ready";
      renderAudioInfo(ui.playerInfo, view.choices, view.choices.sourceRange, view.duration === null ? "loading…" : `${view.duration.toFixed(3)} s`);
      this.renderTranslation(view);
      ui.playerState.textContent =
        view.status === "loading" ? "Loading…" : view.status === "error" ? "" : playing ? "Playing" : view.ended ? "Ended" : "Paused";
      ui.playerPlay.textContent = playing ? "Pause" : "Play";
      ui.playerPlay.setAttribute("aria-label", playing ? "Pause MyDubb audio" : "Play MyDubb audio");
      ui.playerPlay.disabled = view.status === "error";
      ui.playerBack.disabled = !ready;
      ui.playerForward.disabled = !ready;
      ui.playerSeek.disabled = !ready || view.duration === null;
      ui.playerSeek.max = String(view.duration ?? 0);
      if (!this.seeking) {
        ui.playerSeek.value = String(view.currentTime);
        ui.playerCurrent.textContent = formatTime(view.currentTime);
        ui.playerDuration.textContent = formatTime(view.duration);
      }
      ui.playerSeek.setAttribute("aria-valuetext", `${formatTime(view.currentTime)} of ${formatTime(view.duration)}`);
      ui.playerFloating.textContent = view.floating ? "Hide floating player" : "Show floating player";
      ui.playerProblem.textContent = view.problem
        ? PLAYER_PROBLEMS[view.problem]
        : view.status === "loading"
          ? "Loading the audio…"
          : "";
      this.renderSync(view);
    } else {
      this.confirmingSync = false;
      ui.playerState.textContent = "";
      ui.translation.textContent = "";
    }
    const busy = this.loadingAudio || this.audioLoad !== null;
    // The latest result is not in the player (not loaded, failed or released): Load audio.
    const notLoaded = !!result && (!view || result.record.jobId !== view.owner.jobId || view.status === "error");
    ui.playerLoad.hidden = !notLoaded || busy;
    this.renderListen();
  }

  /** The translation of the audio in the player, before its Play button: never another result's. */
  private renderTranslation(view: PanelPlayerView): void {
    const ui = this.ui;
    const jobId = view.owner.jobId;
    const result = this.resultAudio;
    const shown = result?.record.jobId === jobId ? result.translation : this.loaded?.jobId === jobId ? this.loaded : null;
    ui.translationHeading.textContent = `Translation · ${view.choices.languageLabel}`;
    ui.translation.classList.toggle("missing", !shown);
    ui.translation.textContent = shown ? shown.text : "The translation of this audio is no longer available in this panel.";
    if (shown?.tag) ui.translation.lang = shown.tag;
    else ui.translation.removeAttribute("lang");
    ui.translation.dir = shown?.dir ?? "auto";
  }

  /** Your audio without a job, a result or loaded audio: a short empty state instead of idle controls. */
  private renderListen(): void {
    const view = this.sessionView();
    const record = this.record;
    this.ui.listenEmpty.hidden = record !== null || this.resultAudio !== null || view !== null;
    // The latest job is not the audio in the player (running, downloading or failed): said so,
    // and its details stay in Latest job details, never next to the loaded audio's.
    this.ui.jobNote.hidden = !view || !record || record.jobId === view.owner.jobId;
  }

  private renderSync(view: PanelPlayerView): void {
    const ui = this.ui;
    const sync = view.sync;
    if (sync.status !== "off") this.confirmingSync = false;
    const on = sync.status !== "off" && sync.status !== "unavailable";
    // The toggle beside it says "Sync with video": the status says only ON/OFF and why.
    ui.syncStatus.textContent = syncStatusText(sync).replace(/^Sync with video: /, "");
    ui.syncToggle.setAttribute("aria-pressed", String(on));
    ui.syncToggle.disabled = sync.status === "unavailable";
    ui.syncToggle.hidden = this.confirmingSync;
    ui.syncConfirm.hidden = !this.confirmingSync;
    ui.syncPreview.textContent = syncPreviewText(sync);
    ui.syncNotice.textContent = syncNoticeText(sync);
  }

  // ---- Dropping ------------------------------------------------------------------------------

  /**
   * Stop following and showing the current job (never cancels it on the server). The tab's
   * playback session ends too, except for a new Generate (`endPlayback` false).
   */
  private dropJob(message: string | null, endPlayback = true): void {
    this.poll?.abort();
    this.poll = null;
    this.audioLoad?.abort();
    this.audioLoad = null;
    this.resultAudio = null;
    if (endPlayback) {
      this.deps.player.end();
      this.loaded = null;
      void this.deps.storage.remove(loadedKey(this.deps.tabId));
    }
    if (this.record) void this.forgetRecord();
    this.record = null;
    this.sendingOp = null;
    const ui = this.ui;
    if (endPlayback) ui.videoPlace.textContent = "";
    this.setJobStatus("");
    ui.notices.replaceChildren();
    ui.durations.replaceChildren();
    ui.audioStatus.textContent = "";
    ui.checkAgain.hidden = true;
    this.renderRecord();
    this.renderGenerate();
    this.renderPlayer();
    // Why the job and its audio went away is said where they were shown.
    if (message) ui.listenNotice.textContent = message;
    this.setJobError("");
  }

  /** Runs this tab's job-record storage steps one after another (a failed step does not block). */
  private queueJobStore(task: () => Promise<void>): Promise<void> {
    const run = this.jobStore.then(task, task);
    this.jobStore = run.catch(() => undefined);
    return run;
  }

  /** Stores the record only if it is still the one this panel shows when the write runs. */
  private saveRecord(record: JobRecord): Promise<void> {
    return this.queueJobStore(async () => {
      if (this.record?.operationId !== record.operationId) return;
      await this.deps.storage.set({ [jobKey(this.deps.tabId)]: record });
    });
  }

  /** Removes the stored record of that click only; a newer click is never touched. */
  private forgetRecord(operationId = this.record?.operationId): Promise<void> {
    if (!operationId) return Promise.resolve();
    const key = jobKey(this.deps.tabId);
    return this.queueJobStore(async () => {
      const value = (await this.deps.storage.get(key))[key];
      if (isJobRecord(value) && value.operationId === operationId) await this.deps.storage.remove(key);
    });
  }

  private setJobError(text: string): void {
    this.ui.jobError.textContent = text;
  }
}
