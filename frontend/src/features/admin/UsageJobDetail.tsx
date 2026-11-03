import { useEffect, useRef, useState } from "react";

import type { TargetLanguageOption } from "../../api/types";
import { usageApi, type UsageJobDetail as Detail } from "../../api/usageApi";
import {
  basisLabel,
  formatBytes,
  formatCount,
  formatMoney,
  languageName,
  noCostLabel,
  plainLabel,
  serviceLabel,
} from "../../lib/usageFormat";
import {
  CostFigure,
  Loading,
  NotRecorded,
  PartialNote,
  PriceLines,
  PriceSources,
  ReadAt,
  ReasonList,
  ReportError,
  ServiceFigures,
  Utc,
} from "./usageParts";
import { useReport, type AccessHandlers } from "./useReport";

interface Props extends AccessHandlers {
  jobId: string;
  refreshKey: number;
  languages: TargetLanguageOption[];
  onClose: () => void;
}

/** Usage figures only: the transcript and audio stay with the job's owner. */
export function UsageJobDetail({ jobId, refreshKey, languages, onClose, ...access }: Props) {
  const [pages, setPages] = useState<{ owner: string; cursors: string[] }>({
    owner: "",
    cursors: [],
  });
  const owner = `${jobId}#${refreshKey}`;
  const cursors = pages.owner === owner ? pages.cursors : [];
  const cursor = cursors.at(-1);
  const report = useReport(
    `${owner}|${cursor ?? ""}`,
    (signal) => usageApi.job(jobId, cursor, signal),
    access,
  );
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView?.({ block: "start" });
  }, [jobId]);

  const notFound = report.status === "error" && report.error.code === "job_usage_not_found";

  return (
    <section className="panel panel-sky" aria-labelledby="usage-detail-title">
      <div className="panel-head">
        <h2 id="usage-detail-title" ref={heading} tabIndex={-1} className="focus-target">
          Usage of job <span className="usage-id">{jobId}</span>
        </h2>
        <button type="button" className="button ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {report.status === "loading" && <Loading what="this job's usage" />}
      {notFound && (
        <p className="callout" role="status">
          No usage record is stored for this job ID. The job may be older than recording, its
          record may not have been written, retention may have removed it, or the ID may not exist.
          This does not mean the job was free.
        </p>
      )}
      {report.status === "error" && !notFound && (
        <ReportError error={report.error} onRetry={report.retry} />
      )}
      {report.status === "ready" && (
        <DetailBody
          detail={report.data}
          languages={languages}
          hasPrevious={cursors.length > 0}
          onPrevious={() => setPages({ owner, cursors: cursors.slice(0, -1) })}
          onNext={(next) => setPages({ owner, cursors: [...cursors, next] })}
        />
      )}
    </section>
  );
}

function DetailBody({
  detail,
  languages,
  hasPrevious,
  onPrevious,
  onNext,
}: {
  detail: Detail;
  languages: TargetLanguageOption[];
  hasPrevious: boolean;
  onPrevious: () => void;
  onNext: (cursor: string) => void;
}) {
  const { job, attempts, next_cursor: nextCursor } = detail;
  const cost = job.reference_cost;
  return (
    <>
      <ReadAt value={detail.generated_at} />
      <dl className="facts-list small">
        <dt>Started</dt>
        <dd>
          <Utc value={job.started_at} />
        </dd>
        <dt>Finished</dt>
        <dd>{job.finished_at ? <Utc value={job.finished_at} /> : <NotRecorded />}</dd>
        <dt>Status</dt>
        <dd>
          {plainLabel(job.status)}
          {job.error_code && ` (${job.error_code})`}
        </dd>
        <dt>Language</dt>
        <dd>{languageName(job.language, languages)}</dd>
        <dt>Providers</dt>
        <dd>{job.providers}</dd>
        <dt>Audio</dt>
        <dd>
          baseline {formatCount(job.baseline_seconds)} s, target {job.target_audio_seconds} s, final{" "}
          {job.final_audio_seconds === null ? <NotRecorded /> : `${job.final_audio_seconds} s`},
          processing{" "}
          {job.audio_processing_ms === null ? (
            <NotRecorded />
          ) : (
            `${formatCount(job.audio_processing_ms)} ms`
          )}
          , MP3 {job.mp3_bytes === null ? <NotRecorded /> : formatBytes(job.mp3_bytes)}
        </dd>
        <dt>Usage method version</dt>
        <dd>{detail.method_version}</dd>
        <dt>Completeness</dt>
        <dd>{job.complete ? "Complete" : <ReasonList reasons={job.reasons} />}</dd>
        {job.services.map((usage) => (
          <div className="usage-dl-row" key={usage.service}>
            <dt>{serviceLabel(usage.service)}</dt>
            <dd>
              <ServiceFigures usage={usage} />
            </dd>
          </div>
        ))}
        <dt>Reference cost</dt>
        <dd>
          <CostFigure cost={cost} />
          <PartialNote cost={cost} />
        </dd>
      </dl>
      <PriceLines lines={cost.lines} />
      <PriceSources lines={cost.lines} />

      <h3 className="usage-subtitle">
        Provider requests{" "}
        <span className="small muted">({formatCount(detail.attempts_total)} in this job)</span>
      </h3>
      {attempts.length === 0 ? (
        <p className="callout" role="status">
          No provider request was recorded for this job.
        </p>
      ) : (
        <div className="usage-table-wrap">
          <table className="usage-table" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader">#</th>
                <th scope="col" role="columnheader">Service</th>
                <th scope="col" role="columnheader">Outcome</th>
                <th scope="col" role="columnheader">Latency</th>
                <th scope="col" role="columnheader">Usage</th>
                <th scope="col" role="columnheader">Method</th>
                <th scope="col" role="columnheader">Reference cost</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {attempts.map((attempt) => (
                <tr role="row" key={attempt.seq}>
                  <td role="cell" data-label="#">{attempt.seq}</td>
                  <td role="cell" data-label="Service">
                    {serviceLabel(attempt.service)}
                    <span className="block small muted">{attempt.provider_kind}</span>
                  </td>
                  <td role="cell" data-label="Outcome">
                    {plainLabel(attempt.outcome)}
                    <span className="block small muted">
                      {attempt.http_status === null ? "No HTTP status" : `HTTP ${attempt.http_status}`}
                    </span>
                    {attempt.error_code && (
                      <span className="block small muted usage-id">{attempt.error_code}</span>
                    )}
                  </td>
                  <td role="cell" data-label="Latency">{formatCount(attempt.elapsed_ms)} ms</td>
                  <td role="cell" data-label="Usage">
                    {attempt.usage_amount === null
                      ? "Unknown"
                      : `${formatCount(attempt.usage_amount)} ${attempt.usage_unit}`}
                    <span className="block small muted">{basisLabel(attempt.usage_basis)}</span>
                  </td>
                  <td role="cell" data-label="Method">
                    {attempt.usage_method ? (
                      <span className="usage-id">{attempt.usage_method}</span>
                    ) : (
                      <NotRecorded />
                    )}
                  </td>
                  <td role="cell" data-label="Reference cost">
                    {attempt.reference_cost === null ? (
                      <span className="small">{noCostLabel(attempt.no_cost_reason)}</span>
                    ) : (
                      <span title={`Exact: ${attempt.reference_cost} ${cost.currency}`}>
                        {cost.currency} {formatMoney(attempt.reference_cost)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(hasPrevious || nextCursor) && (
        <nav className="usage-pager" aria-label="Provider request pages">
          <button
            type="button"
            className="button ghost"
            disabled={!hasPrevious}
            onClick={onPrevious}
          >
            Previous
          </button>
          <button
            type="button"
            className="button ghost"
            disabled={!nextCursor}
            onClick={() => nextCursor && onNext(nextCursor)}
          >
            Next
          </button>
        </nav>
      )}
    </>
  );
}
