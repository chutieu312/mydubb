// The MyDubb half of the side panel: the account connection, the dubbing form, the job the tab
// follows and the result player. The rules for the form and the request are the website's own
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
import { formatSeconds, previewTargetDuration } from "../../../frontend/src/lib/timestamps";
import { analyzeTranscriptTiming, captionClock, type TranscriptTiming } from "../../../frontend/src/lib/transcriptTiming";
import { formKey, jobKey } from "../shared/messages";
import { MyDubbError, NO_ANSWER, type MyDubbApi } from "./api";
import { AUTH_KEY, connect, connectErrorMessage, isLive, isStoredAuth, type StoredAuth } from "./auth";
import type { CurrentLesson } from "./draft";
import {
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

const FIELD_IDS: Record<string, string> = {
  transcript: "transcript-error",
  first_sentence_start: "first-start-error",
  last_sentence_start: "last-start-error",
  target_language: "target-language-error",
  voice: "voice-error",
  speed: "speed-error",
};
const SAVE_DEBOUNCE_MS = 250;
const LESSON_CHANGED =
  "The lecture changed. A job already sent keeps running on MyDubb, but its result is not shown under this lecture.";
const ACCOUNT_CHANGED = "The MyDubb account changed, so the previous job and result were cleared from this panel.";
const CONNECTION_ENDED = "Your MyDubb connection ended (expired or disconnected). Connect again to continue.";

type Storage = Pick<chrome.storage.StorageArea, "get" | "set" | "remove">;

export interface DubbingDeps {
  tabId: number;
  origin: string;
  extensionId: string;
  api: MyDubbApi;
  storage: Storage;
  launchWebAuthFlow(url: string): Promise<string | undefined>;
  randomId(): string;
  now(): number;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface DubbingHost {
  /** The lecture now shown in the tab; undefined until the tab reported a state. */
  currentLesson(): CurrentLesson;
  /** The transcript as the panel's text box holds it. */
  transcript(): string;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function dubbingUi() {
  return {
    accountStatus: byId("account-status"),
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
    speed: byId<HTMLSelectElement>("speed"),
    lengthSummary: byId("length-summary"),
    disclosure: byId("disclosure"),
    formError: byId("form-error"),
    generate: byId<HTMLButtonElement>("generate"),
    resultSection: byId("result-section"),
    jobStatus: byId("job-status"),
    jobError: byId("job-error"),
    checkAgain: byId<HTMLButtonElement>("check-again"),
    jobChoices: byId("job-choices"),
    result: byId("result"),
    audio: byId<HTMLAudioElement>("result-audio"),
    audioStatus: byId("audio-status"),
    durations: byId("result-durations"),
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
  private audioUrl: string | null = null;
  private saveTimer: number | null = null;
  private disposed = false;
  private readonly cleanup = new AbortController();

  constructor(
    private readonly deps: DubbingDeps,
    private readonly host: DubbingHost,
  ) {}

  async start(): Promise<void> {
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
    ui.speed.addEventListener("change", () => this.update({ speed: Number(ui.speed.value) }), { signal });
    // The result is already at the chosen speed: the player always plays it at 1x.
    ui.audio.addEventListener("ratechange", () => this.keepNormalRate(), { signal });
    setOptions(
      ui.speed,
      AUDIO_SPEEDS.map((s) => ({ value: String(s), label: speedLabel(s) })),
      String(DEFAULT_SPEED),
    );

    const stored = await this.deps.storage.get([AUTH_KEY, formKey(this.deps.tabId), jobKey(this.deps.tabId)]);
    const form = stored[formKey(this.deps.tabId)];
    if (isFormRecord(form)) this.form = form;
    this.applyAuth(stored[AUTH_KEY], false);
    const record = stored[jobKey(this.deps.tabId)];
    if (isJobRecord(record) && recordBelongs(record, this.account(), this.host.currentLesson())) {
      this.record = record;
      this.renderRecord();
      if (record.state === "created") this.follow(record);
      else this.setJobError(UNKNOWN_OUTCOME);
    } else if (record !== undefined) {
      void this.deps.storage.remove(jobKey(this.deps.tabId));
    }
    this.renderForm();
    void this.verifyAuth();
    await this.loadMeta();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanup.abort();
    this.poll?.abort();
    this.poll = null;
    this.clearAudio();
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
    if (key !== this.lastLesson) {
      if (this.lastLesson !== undefined) this.lessonGen += 1;
      this.lastLesson = key;
    }
    if (this.record && !recordBelongs(this.record, this.account(), key)) {
      this.dropJob(LESSON_CHANGED);
    }
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
    // Another account (or none): nothing of the previous one may stay on screen.
    if (this.record) this.dropJob(fromChange && hadAuth ? ACCOUNT_CHANGED : null);
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
    this.ui.accountStatus.textContent = "Disconnected from MyDubb.";
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
      ui.accountStatus.textContent = `Connected as ${name ? `${name} (${auth.user.email})` : auth.user.email}.`;
    } else if (this.connecting) {
      ui.accountStatus.textContent = "Sign in to MyDubb in the window that opened.";
    } else if (ui.accountStatus.textContent !== "Disconnected from MyDubb.") {
      ui.accountStatus.textContent =
        "Not connected. Connect your MyDubb invitation account to generate audio (sign-in happens on mydubb.com).";
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
    ui.speed.value = String(AUDIO_SPEEDS.includes(form.speed as never) ? form.speed : DEFAULT_SPEED);
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
    ui.ignoreTimestamps.parentElement!.hidden = timing.kind === "cues";
    if (timing.kind === "none") return;
    if (timing.kind === "cues") {
      ui.timingText.textContent =
        "SRT/WebVTT timing is not used yet: this transcript is processed as plain text with the two start times below.";
      return;
    }
    if (timing.kind === "invalid") {
      ui.timingText.textContent = ignore
        ? "The timestamps are ignored: the transcript is processed as plain text."
        : `The timestamps cannot be used. ${timing.message} Fix them, or process the transcript as plain text.`;
      return;
    }
    if (ignore) {
      ui.timingText.textContent = "Timestamps detected but ignored: the whole audio is fitted to the two start times.";
      return;
    }
    const fields = fieldsFromCaptions(timing);
    ui.timingText.textContent =
      `Timestamps detected: ${timing.captions} captions from ${captionClock(timing.first)} to ${captionClock(timing.last)}. ` +
      (fields
        ? "The start times below are filled from the first and last caption (whole seconds). "
        : "They start within the same second, so the start times below cannot be filled: enter them. ") +
      "Timing follows the captions and is estimated: some sentences may be grouped together or start slightly off their caption time.";
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
      this.ui.lengthSummary.textContent =
        "Expected audio length: — (enter both start times; the last must be after the first).";
      return;
    }
    const output = formatClock(previewOutputSeconds(baseline, speed));
    const relation =
      speed === DEFAULT_SPEED
        ? "It matches the time between your two start times."
        : `At ${speedLabel(speed)} the audio is ${speed > DEFAULT_SPEED ? "shorter" : "longer"} than the time between the two start times.`;
    this.ui.lengthSummary.textContent = `Expected audio length: ${output} (${formatSeconds(baseline)} at 1x). ${relation} Estimate only; MyDubb calculates the final length.`;
  }

  private renderGenerate(): void {
    const ui = this.ui;
    ui.generate.disabled = this.disposed || !this.meta || !this.auth || this.sendingOp !== null;
    ui.generate.textContent = this.sendingOp !== null ? "Sending…" : "Generate audio";
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

  private setFieldErrors(fields: { field: string; message: string }[]): void {
    for (const id of Object.values(FIELD_IDS)) byId(id).textContent = "";
    for (const f of fields) {
      const id = FIELD_IDS[f.field];
      if (id) byId(id).textContent = f.message;
    }
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
    const choices: JobChoices = {
      languageLabel: (this.languages.find((l) => l.id === targetLanguage) ?? VIETNAMESE).label,
      voiceLabel: this.voices.find((v) => v.id === voice)?.label ?? voice,
      speed: body.speed,
      timed: usesTimestamps(timing, this.form.ignoreTimestamps),
      firstStart: body.first_sentence_start,
      lastStart: body.last_sentence_start,
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
    // A new job replaces the one followed so far (which keeps running on the server).
    this.dropJob(null);
    this.record = record;
    this.sendingOp = record.operationId;
    this.renderGenerate();
    this.renderRecord();
    ui.jobStatus.textContent = "Sending to MyDubb…";
    const authGen = this.authGen;
    const lessonGen = this.lessonGen;
    const current = () =>
      !this.disposed &&
      authGen === this.authGen &&
      lessonGen === this.lessonGen &&
      this.record?.operationId === record.operationId;
    // Written before sending: if the panel closes before the answer, reopening it says that the
    // outcome is unknown instead of assuming that nothing was created.
    await this.deps.storage.set({ [jobKey(this.deps.tabId)]: record });

    let job: Job;
    try {
      job = await this.deps.api.createJob(auth.token, body, SEND_TIMEOUT_MS);
    } catch (error) {
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
    await this.deps.storage.set({ [jobKey(this.deps.tabId)]: created });
    this.showStatus(job);
    this.follow(created);
  }

  private sendFailed(error: unknown, auth: StoredAuth): void {
    if (error instanceof MyDubbError && NO_ANSWER.has(error.code)) {
      // Never sent again automatically: the job may exist.
      this.ui.jobStatus.textContent = "";
      this.setJobError(UNKNOWN_OUTCOME);
      return;
    }
    // The server refused it: no job was created.
    this.forgetRecord();
    this.ui.resultSection.hidden = true;
    if (error instanceof MyDubbError && error.isUnauthenticated) {
      void this.expireAuth(auth);
      return;
    }
    if (error instanceof MyDubbError) this.setFieldErrors(error.fields);
    this.ui.formError.textContent = jobErrorMessage(error);
  }

  // ---- Following a job -----------------------------------------------------------------------

  private follow(record: JobRecord): void {
    const auth = this.auth;
    const jobId = record.jobId;
    if (!auth || !jobId) return;
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
      switch (outcome.kind) {
        case "aborted":
          return;
        case "unauthenticated":
          await this.expireAuth(auth);
          return;
        case "gone":
          this.forgetRecord();
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
          await this.loadResult(auth, jobId, controller.signal, current);
      }
    });
  }

  private showStatus(job: Job): void {
    this.ui.jobStatus.textContent = STATUS_TEXT[job.status] ?? `Status: ${job.status}`;
  }

  private async loadResult(auth: StoredAuth, jobId: string, signal: AbortSignal, current: () => boolean): Promise<void> {
    let result: JobResult;
    try {
      result = await this.deps.api.getResult(auth.token, jobId, signal);
    } catch (error) {
      if (!current()) return;
      if (error instanceof MyDubbError && error.isUnauthenticated) return void this.expireAuth(auth);
      if (error instanceof MyDubbError && error.code === "result_expired") this.forgetRecord();
      else this.ui.checkAgain.hidden = false;
      this.setJobError(jobErrorMessage(error));
      return;
    }
    if (!current()) return;
    this.renderResult(result);
    this.ui.audioStatus.textContent = "Loading the audio…";
    let blob: Blob;
    try {
      blob = await this.deps.api.getAudio(auth.token, result.audio.url, signal);
    } catch (error) {
      if (!current()) return;
      if (error instanceof MyDubbError && error.isUnauthenticated) return void this.expireAuth(auth);
      this.ui.audioStatus.textContent = `The audio could not be loaded: ${jobErrorMessage(error)}`;
      this.ui.checkAgain.hidden = false;
      return;
    }
    if (!current()) return;
    this.setAudio(blob);
    this.ui.audioStatus.textContent = "Ready. Press play when you want to listen.";
  }

  private renderRecord(): void {
    const ui = this.ui;
    const record = this.record;
    ui.resultSection.hidden = record === null;
    ui.jobChoices.replaceChildren();
    ui.result.hidden = true;
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
    const language = jobLanguage(result, this.languages);
    ui.translation.textContent = result.translation.text;
    if (language.tag) ui.translation.lang = language.tag;
    else ui.translation.removeAttribute("lang");
    ui.translation.dir = language.dir ?? "auto";
    ui.notices.replaceChildren(
      ...result.notices.map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      }),
    );
  }

  // ---- Audio ---------------------------------------------------------------------------------

  private setAudio(blob: Blob): void {
    this.clearAudio();
    this.audioUrl = this.deps.createObjectURL(blob);
    const audio = this.ui.audio;
    audio.autoplay = false;
    audio.src = this.audioUrl;
    this.keepNormalRate();
  }

  private keepNormalRate(): void {
    const audio = this.ui.audio;
    if (audio.defaultPlaybackRate !== 1) audio.defaultPlaybackRate = 1;
    if (audio.playbackRate !== 1) audio.playbackRate = 1;
  }

  private clearAudio(): void {
    const audio = this.ui.audio;
    audio.pause();
    if (audio.hasAttribute("src")) {
      audio.removeAttribute("src");
      audio.load();
    }
    if (this.audioUrl) this.deps.revokeObjectURL(this.audioUrl);
    this.audioUrl = null;
  }

  // ---- Dropping ------------------------------------------------------------------------------

  /** Stop following and showing the current job (never cancels it on the server). */
  private dropJob(message: string | null): void {
    this.poll?.abort();
    this.poll = null;
    this.clearAudio();
    if (this.record) this.forgetRecord();
    this.record = null;
    this.sendingOp = null;
    const ui = this.ui;
    ui.jobStatus.textContent = "";
    ui.translation.textContent = "";
    ui.notices.replaceChildren();
    ui.durations.replaceChildren();
    ui.audioStatus.textContent = "";
    ui.checkAgain.hidden = true;
    this.renderRecord();
    this.renderGenerate();
    if (message) {
      ui.resultSection.hidden = true;
      ui.formError.textContent = message;
    }
    this.setJobError("");
  }

  private forgetRecord(): void {
    const record = this.record;
    if (!record) return;
    const key = jobKey(this.deps.tabId);
    void this.deps.storage.get(key).then((stored) => {
      const value = stored[key];
      if (isJobRecord(value) && value.operationId === record.operationId) void this.deps.storage.remove(key);
    });
  }

  private setJobError(text: string): void {
    this.ui.jobError.textContent = text;
  }
}
