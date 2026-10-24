import type { JobStatus, VoiceOption } from "../../api/types";
import { formatClock, speedLabel } from "../../lib/speed";
import { ResultView } from "./ResultView";
import { useJobPolling } from "./useJobPolling";

const STAGES: { status: JobStatus; label: string }[] = [
  { status: "queued", label: "Queued" },
  { status: "translating", label: "Translating" },
  { status: "synthesizing", label: "Generating voice" },
  { status: "processing", label: "Processing audio" },
  { status: "completed", label: "Completed" },
];

interface Props {
  jobId: string;
  voices: VoiceOption[];
  onSessionExpired: () => void;
}

export function JobPanel({ jobId, voices, onSessionExpired }: Props) {
  const { job, error } = useJobPolling(jobId, onSessionExpired);

  if (!job) {
    return (
      <section className="panel panel-coral" aria-live="polite">
        <p>{error ?? "Loading job status…"}</p>
      </section>
    );
  }

  // Stages are reported by the server; no progress percentage is invented.
  const currentIndex = STAGES.findIndex((s) => s.status === job.status);
  const failed = job.status === "failed";
  const completed = job.status === "completed";
  const voiceLabel = voices.find((v) => v.id === job.voice)?.label ?? job.voice;

  return (
    <section className="panel panel-coral" aria-labelledby="job-title">
      <h2 id="job-title">
        {failed ? "Audio could not be created" : completed ? "Your audio" : "Creating your audio…"}
      </h2>
      {/* What the server stored for this job, not what the form shows now. */}
      <p className="muted small">
        Voice {voiceLabel} · Duration at 1x {job.target_duration} · Speed {speedLabel(job.speed)} ·
        Planned audio length {formatClock(job.output_duration_seconds)}
      </p>
      <ol className="stages" aria-label="Progress" aria-live="polite">
        {STAGES.map((stage, index) => {
          let state = "pending";
          if (!failed && index < currentIndex) state = "done";
          if (!failed && index === currentIndex) state = completed ? "done" : "active";
          return (
            <li
              key={stage.status}
              className={`stage ${state}`}
              aria-current={state === "active" ? "step" : undefined}
            >
              {stage.label}
            </li>
          );
        })}
        {failed && <li className="stage failed">Failed</li>}
      </ol>
      {failed && job.error && (
        <p className="callout error" role="alert">
          {job.error.message}
        </p>
      )}
      {error && <p className="callout warning">{error}</p>}
      {completed && (
        <ResultView jobId={job.id} voiceLabel={voiceLabel} onSessionExpired={onSessionExpired} />
      )}
    </section>
  );
}
