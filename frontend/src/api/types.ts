export type JobStatus =
  | "queued"
  | "translating"
  | "synthesizing"
  | "processing"
  | "completed"
  | "failed";

export const TERMINAL_STATUSES: readonly JobStatus[] = ["completed", "failed"];

export interface VoiceOption {
  id: string;
  // Name shown to the user, e.g. "Andrew Multilingual".
  label: string;
  provider_voice: string;
  description: string;
}

export interface AppMeta {
  provider_mode: string;
  // True while any pipeline component is still a mock.
  mock_mode: boolean;
  // Implementation behind each pipeline stage: translation/speech "mock" | "azure", audio
  // "mock" | "ffmpeg".
  providers: { translation: string; speech: string; audio: string };
  voices: VoiceOption[];
  timestamp_format: string;
  result_ttl_seconds: number;
  // How users sign in. Read it with authModeOf(): a missing or unknown value must not be guessed.
  auth?: { mode?: string; self_registration?: boolean; password_reset?: boolean };
  // Whether the form offers importing a YouTube video's captions. Missing means not offered.
  youtube_import?: { enabled?: boolean; provider?: string | null };
  // "Try as guest" and its limits. Read it with guestAccessOf(); missing means not offered.
  guest_access?: {
    enabled?: boolean;
    jobs_per_session?: number;
    jobs_per_ip?: number;
    ip_window_seconds?: number;
    max_words?: number;
    max_output_seconds?: number;
    session_ttl_seconds?: number;
  };
}

/** The existing English captions of a video, written as a timestamped transcript. */
export interface YouTubeImport {
  // One line with the caption's start time (M:SS.mmm or H:MM:SS.mmm), then one line with its
  // text, for every caption. Shown and edited as plain text.
  transcript: string;
  language: string;
  caption_count: number;
  // Captions without any text, left out of the transcript.
  skipped_empty_captions: number;
  first_caption_start_ms: number;
  last_caption_start_ms: number;
  // HH:MM:SS (whole seconds) for the two time fields; null when the captions give no baseline.
  first_sentence_start: string | null;
  last_sentence_start: string | null;
  provider: string;
}

export interface SessionInfo {
  authenticated: boolean;
  csrf_token: string;
  expires_at: string;
}

export interface CreateJobInput {
  transcript: string;
  first_sentence_start: string;
  last_sentence_start: string;
  voice: string;
  // One of 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2. The server rejects anything else and computes the
  // output length itself.
  speed: number;
  // "timed" uses the caption times of a timestamped transcript; omitted means plain.
  timing_mode?: "timed";
}

export interface Job {
  id: string;
  status: JobStatus;
  voice: string;
  first_sentence_start: string;
  last_sentence_start: string;
  // Baseline: last - first sentence start (the duration at 1x). Independent of the speed.
  target_duration_seconds: number;
  target_duration: string;
  baseline_duration_seconds: number;
  // Speed chosen when the job was submitted (1 for jobs from before the option existed).
  speed: number;
  // Planned output length: baseline / speed. The verified length is in the result.
  output_duration_seconds: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  result_expires_at: string | null;
  error: { code: string; message: string } | null;
}

/** Durations measured on the real audio; seconds are samples / sample_rate, unrounded. */
export interface AudioDuration {
  sample_rate: number;
  // Output target: baseline / speed, rounded to a whole sample.
  target_seconds: number;
  target_samples: number;
  baseline_seconds: number;
  speed: number;
  // Natural length of the speech before the tempo change.
  source_seconds: number;
  source_samples: number;
  // PCM after the tempo change, before MP3 encoding.
  processed_seconds: number;
  processed_samples: number;
  // Final MP3: what a decoder produces, the playable length its gapless header declares, and
  // ffprobe's container duration (reported as is; may include encoder delay and padding).
  mp3_decoded_seconds: number;
  mp3_decoded_samples: number;
  mp3_header_seconds: number;
  mp3_header_samples: number;
  mp3_container_seconds: number;
  // >1 faster, <1 slower; null when the speech was already within rounding of the target.
  tempo_factor: number | null;
  padded_samples: number;
  trimmed_samples: number;
  // Samples by which the MP3 header's end padding was corrected; 0 when it was already exact.
  mp3_padding_adjusted_samples: number;
}

/** Timed mode: one frame of the output timeline (one block, or grouped blocks). */
export interface TimedFrame {
  first_block: number;
  last_block: number;
  start_seconds: number;
  frame_seconds: number;
  audio_seconds: number;
  // >1 faster; null when the speech fitted at its natural speed.
  tempo_factor: number | null;
  padded_seconds: number;
}

/** How a timed job used the caption times; starts inside captions are estimates. */
export interface Timing {
  mode: string;
  captions: number;
  blocks: number;
  source_first_seconds: number;
  source_last_seconds: number;
  source_baseline_seconds: number;
  selected_baseline_seconds: number;
  speech_requests: number;
  // Null when the audio was not placed on a timeline (mock audio).
  frames: number | null;
  removed_boundaries: number | null;
  tempo_warning_level: number | null;
  max_tempo_factor: number | null;
  frames_over_warning_level: number | null;
  // Computed from the tempo factors, not measured.
  estimated_max_displacement_seconds: number | null;
  frame_details: TimedFrame[] | null;
}

export interface JobResult {
  job_id: string;
  // What the job was submitted with, also when the audio was not adjusted (mock audio).
  baseline_duration_seconds: number;
  speed: number;
  output_duration_seconds: number;
  translation: { text: string; is_illustrative: boolean; provider: string };
  audio: {
    url: string;
    download_url: string;
    content_type: string;
    // Speech provider that produced the audio ("mock-speech", "azure-speech").
    provider: string;
    is_fixture: boolean;
    duration_adjusted: boolean;
    // Null when the duration was not adjusted.
    duration: AudioDuration | null;
  };
  expires_at: string;
  notices: string[];
  // Timed jobs only (absent or null for plain jobs and older results).
  timing?: Timing | null;
}

export interface FieldError {
  field: string;
  message: string;
}
