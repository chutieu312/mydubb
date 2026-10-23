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
  // True while any pipeline component (speech, audio processing) is still a mock.
  mock_mode: boolean;
  // Implementation behind each pipeline stage: "mock" or "azure" (audio: always "mock" for now).
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
  };
  expires_at: string;
  notices: string[];
}

export interface FieldError {
  field: string;
  message: string;
}
