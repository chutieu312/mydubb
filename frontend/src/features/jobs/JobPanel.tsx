import type { JobStatus, VoiceOption } from "../../api/types";
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
      <section className="card" aria-live="polite">
        <p>{error ?? "Loading job status…"}</p>
      </section>
    );
  }

  // Stages are reported by the server; no progress percentage is invented.
  const currentIndex = STAGES.findIndex((s) => s.status === job.status);
  const failed = job.status === "failed";

  return (
    <section className="card stack" aria-labelledby="job-title">
      <h2 id="job-title">Processing status</h2>
      <p className="muted">
        Voice {voices.find((v) => v.id === job.voice)?.label ?? job.voice} · Target duration {job.target_duration} ({job.target_duration_seconds}{" "}
        s, calculated by the server)
      </p>
      <ol className="stages" aria-live="polite">
        {STAGES.map((stage, index) => {
          let state = "pending";
          if (!failed && index < currentIndex) state = "done";
          if (!failed && index === currentIndex) state = job.status === "completed" ? "done" : "active";
          return (
            <li key={stage.status} className={`stage ${state}`}>
              {stage.label}
            </li>
          );
        })}
        {failed && <li className="stage failed">Failed</li>}
      </ol>
      {failed && job.error && (
        <p className="error" role="alert">
          {job.error.message}
        </p>
      )}
      {error && <p className="warning">{error}</p>}
      {job.status === "completed" && (
        <ResultView jobId={job.id} onSessionExpired={onSessionExpired} />
      )}
    </section>
  );
}
