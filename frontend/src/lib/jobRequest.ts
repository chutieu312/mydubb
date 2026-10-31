// How the dubbing form turns what it holds into a job request. Shared by the Studio
// (features/dubbing/DubbingForm.tsx) and the Chrome extension's panel (extension/src/panel), so
// both send the same request for the same input. The server validates everything again.

import type { CreateJobInput } from "../api/types";
import { formatSeconds } from "./timestamps";
import type { TranscriptTiming } from "./transcriptTiming";

/** The caption pair the two time fields were last filled from; null for a non-timed transcript. */
export function captionKey(timing: TranscriptTiming): string | null {
  return timing.kind === "timed" ? `${timing.first}-${timing.last}` : null;
}

/**
 * The two fields for the first and last caption: their starts truncated to whole seconds (the
 * fields' HH:MM:SS contract, as the import suggests them). Null when both fall in the same second.
 */
export function fieldsFromCaptions(timing: { first: number; last: number }) {
  const first = Math.floor(timing.first);
  const last = Math.floor(timing.last);
  return last > first ? { first: formatSeconds(first), last: formatSeconds(last) } : null;
}

/**
 * Whether the request asks for timed mode: a transcript with timestamps on their own lines, unless
 * the user ticked "Ignore the timestamps". Invalid timestamps also ask for it, so the server
 * explains what is wrong instead of silently processing the text as plain.
 */
export function usesTimestamps(timing: TranscriptTiming, ignoreTimestamps: boolean): boolean {
  return (timing.kind === "timed" || timing.kind === "invalid") && !ignoreTimestamps;
}

export interface JobFormValues {
  transcript: string;
  firstStart: string;
  lastStart: string;
  voice: string;
  speed: number;
  // Empty when the server lists no output languages: nothing is sent (the server's default).
  targetLanguage: string;
  ignoreTimestamps: boolean;
}

/** The POST /api/jobs body for these form values, exactly as the form holds them. */
export function buildJobRequest(values: JobFormValues, timing: TranscriptTiming): CreateJobInput {
  return {
    transcript: values.transcript,
    first_sentence_start: values.firstStart,
    last_sentence_start: values.lastStart,
    voice: values.voice,
    speed: values.speed,
    // Only sent for timed transcripts; a plain request is unchanged (the server's default).
    ...(usesTimestamps(timing, values.ignoreTimestamps) ? { timing_mode: "timed" as const } : {}),
    // The language chosen now; the job keeps it whatever the form shows later.
    ...(values.targetLanguage ? { target_language: values.targetLanguage } : {}),
  };
}
