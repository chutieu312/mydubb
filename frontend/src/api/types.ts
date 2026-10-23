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
}

export interface Job {
  id: string;
  status: JobStatus;
  voice: string;
  first_sentence_start: string;
  last_sentence_start: string;
  target_duration_seconds: number;
  target_duration: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  result_expires_at: string | null;
  error: { code: string; message: string } | null;
}

/** Durations measured on the real audio; seconds are samples / sample_rate, unrounded. */
export interface AudioDuration {
  sample_rate: number;
  target_seconds: number;
  target_samples: number;
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
}

export interface JobResult {
  job_id: string;
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
}

export interface FieldError {
  field: string;
  message: string;
}
