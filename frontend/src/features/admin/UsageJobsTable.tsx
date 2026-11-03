import type { TargetLanguageOption } from "../../api/types";
import type { UsageJob } from "../../api/usageApi";
import { formatBytes, formatCount, languageName, plainLabel } from "../../lib/usageFormat";
import { CostFigure, NotRecorded, ReasonList, ServiceFigures, Utc } from "./usageParts";

interface Props {
  jobs: UsageJob[];
  languages: TargetLanguageOption[];
  onOpen: (jobId: string) => void;
}

function Cost({ job }: { job: UsageJob }) {
  if (job.providers === "mock") return <span className="muted">Mock: not billed</span>;
  return <CostFigure cost={job.reference_cost} />;
}

export function UsageJobsTable({ jobs, languages, onOpen }: Props) {
  return (
    <div className="usage-table-wrap">
      <table className="usage-table" role="table">
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">Job</th>
            <th scope="col" role="columnheader">Settings</th>
            <th scope="col" role="columnheader">Status</th>
            <th scope="col" role="columnheader">Translator</th>
            <th scope="col" role="columnheader">Speech</th>
            <th scope="col" role="columnheader">Reference cost</th>
            <th scope="col" role="columnheader">Audio</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {jobs.map((job) => (
            <tr role="row" key={job.job_id}>
              <td role="cell" data-label="Job">
                <span className="usage-id">{job.job_id}</span>
                <span className="block small muted">
                  <Utc value={job.started_at} />
                </span>
                <button
                  type="button"
                  className="link-button usage-open"
                  onClick={() => onOpen(job.job_id)}
                  aria-label={`View usage of job ${job.job_id}`}
                >
                  View usage
                </button>
              </td>
              <td role="cell" data-label="Settings">
                <ul className="usage-lines">
                  <li>{languageName(job.language, languages)}</li>
                  <li>{job.voice}</li>
                  <li>{(job.speed_percent / 100).toFixed(2).replace(/\.?0+$/, "")}x</li>
                  <li>{job.timing_mode}</li>
                </ul>
              </td>
              <td role="cell" data-label="Status">
                <span className="block">{plainLabel(job.status)}</span>
                {job.outcome && job.outcome !== job.status && (
                  <span className="block small muted">recorded: {plainLabel(job.outcome)}</span>
                )}
                {job.error_code && (
                  <span className="block small muted usage-id">{job.error_code}</span>
                )}
                {job.complete ? (
                  <span className="block small usage-complete">Complete</span>
                ) : (
                  <>
                    <span className="block small usage-incomplete">Incomplete</span>
                    <ReasonList reasons={job.reasons} />
                  </>
                )}
              </td>
              {job.services.map((usage) => (
                <td
                  role="cell"
                  key={usage.service}
                  data-label={usage.service === "speech" ? "Speech" : "Translator"}
                >
                  <ServiceFigures usage={usage} />
                </td>
              ))}
              <td role="cell" data-label="Reference cost">
                <Cost job={job} />
              </td>
              <td role="cell" data-label="Audio">
                <dl className="usage-pairs">
                  <dt>Baseline</dt>
                  <dd>{formatCount(job.baseline_seconds)} s</dd>
                  <dt>Target</dt>
                  <dd>{job.target_audio_seconds} s</dd>
                  <dt>Final</dt>
                  <dd>
                    {job.final_audio_seconds === null ? (
                      <NotRecorded />
                    ) : (
                      `${job.final_audio_seconds} s`
                    )}
                  </dd>
                  <dt>Processing</dt>
                  <dd>
                    {job.audio_processing_ms === null ? (
                      <NotRecorded />
                    ) : (
                      `${formatCount(job.audio_processing_ms)} ms`
                    )}
                  </dd>
                  <dt>MP3</dt>
                  <dd>{job.mp3_bytes === null ? <NotRecorded /> : formatBytes(job.mp3_bytes)}</dd>
                </dl>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
