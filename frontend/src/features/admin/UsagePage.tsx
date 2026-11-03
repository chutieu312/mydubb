import { useEffect, useRef, useState } from "react";

import type { TargetLanguageOption } from "../../api/types";
import { usageApi, type UsageFilters } from "../../api/usageApi";
import { AppLink } from "../../components/AppLink";
import { navigateTo, USAGE_PATH, useSearch } from "../../lib/appRoute";
import { buildAddress, parseAddress, resolveFilters } from "../../lib/usageFilters";
import { UsageFiltersForm } from "./UsageFiltersForm";
import { UsageJobDetail } from "./UsageJobDetail";
import { UsageJobsTable } from "./UsageJobsTable";
import { UsageSummaryCards } from "./UsageSummaryCards";
import { Loading, ReadAt, ReportError } from "./usageParts";
import { useReport, type AccessHandlers } from "./useReport";

interface Props extends AccessHandlers {
  languages: TargetLanguageOption[];
}

const NOTES = [
  "Reference cost is the recorded usage at paid-tier list prices. The services run on the Free tier, the Free allowance is not deducted, and the actual invoice has not been verified.",
  "Not included: Supadata, Render, Neon, taxes, payment fees and revenue.",
  "Translator usage is the X-metered-usage figure the provider reports (actual). Without it the usage is unknown; the size sent is not used as a billed amount.",
  "Speech usage is an estimate by the method stored with each request, not a figure from Microsoft.",
  "A failed or timed-out request is not assumed free: its usage is unknown. None means nothing was sent or billed, which is different from unknown.",
  "Mock requests are counted apart. A job that mixes providers keeps the usage of its real provider.",
  "Each request is priced at the price in force on its own date. Usage with no price for its date is listed apart.",
  "Only what was recorded is here. A job with no usage record is not free, and a crash, a failed write or retention can leave gaps.",
  "Audio processing is the wall time of the whole audio stage, not of FFmpeg alone.",
  "Summary, jobs and job usage are read separately, each at its own time, so they can differ while jobs are running. Nothing updates on its own: use Refresh.",
];

export function UsagePage({ languages, onSessionExpired, onAccessEnded }: Props) {
  const search = useSearch();
  const address = parseAddress(search);
  const access = { onSessionExpired, onAccessEnded };
  const [refreshes, setRefreshes] = useState(0);

  // The period of a default view is fixed when the page opens or is refreshed, not on every render.
  const [now, setNow] = useState(() => Date.now());
  const filters = resolveFilters(address, now);
  const identity = JSON.stringify([filters, refreshes]);

  const [pages, setPages] = useState<{ owner: string; cursors: string[] }>({
    owner: identity,
    cursors: [],
  });
  const cursors = pages.owner === identity ? pages.cursors : [];
  const cursor = cursors.at(-1);

  const summary = useReport(identity, (signal) => usageApi.summary(filters, signal), access);
  const jobs = useReport(
    `${identity}|${cursor ?? ""}`,
    (signal) => usageApi.jobs(filters, cursor, signal),
    access,
  );

  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    const previous = document.title;
    document.title = "Usage & Costs · MyDubb";
    return () => {
      document.title = previous;
    };
  }, []);

  const refresh = () => {
    setNow(Date.now());
    setRefreshes((n) => n + 1);
  };
  const apply = (next: UsageFilters) => {
    const target = buildAddress({
      since: next.since,
      until: next.until,
      language: next.language,
      jobId: next.jobId,
    });
    // The same filters again: there is no new address to go to, so read them again.
    if (target === search) refresh();
    else navigateTo(`${USAGE_PATH}${target}`);
  };
  const openDetail = (jobId: string) =>
    navigateTo(`${USAGE_PATH}${buildAddress({ ...address, detail: jobId })}`);
  const closeDetail = () =>
    navigateTo(`${USAGE_PATH}${buildAddress({ ...address, detail: undefined })}`);

  const emptyDatabase =
    summary.status === "ready" &&
    summary.data.jobs_total === 0 &&
    summary.data.first_usage_at === null;

  return (
    <div className="usage-page">
      <section className="hero">
        <p className="eyebrow">Administration</p>
        <h1 ref={heading} tabIndex={-1} className="focus-target">
          Usage &amp; Costs
        </h1>
        <p className="muted">
          What dubbing jobs asked of the providers, and what that would cost at list prices.
        </p>
        <p>
          <AppLink href="/" className="link-button">
            Back to Studio
          </AppLink>
        </p>
      </section>

      <p className="callout warning usage-banner">
        <strong>Reference cost — not an invoice.</strong> Usage is what was recorded; invoices have
        not been verified, and Supadata, hosting, taxes and payments are not included.
      </p>

      <UsageFiltersForm
        applied={filters}
        languages={languages}
        onApply={apply}
        onRefresh={refresh}
      />

      <details className="disclosure plain">
        <summary>How to read these numbers</summary>
        <ul className="notes small disclosure-body">
          {NOTES.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>

      {summary.status === "loading" && <Loading what="the summary" />}
      {summary.status === "error" && (
        <ReportError error={summary.error} onRetry={summary.retry} />
      )}
      {emptyDatabase && (
        <p className="callout" role="status">
          No usage has been recorded in the database yet.
        </p>
      )}
      {summary.status === "ready" && <UsageSummaryCards summary={summary.data} />}

      <section className="panel" aria-labelledby="usage-jobs-title">
        <div className="panel-head">
          <h2 id="usage-jobs-title">Jobs</h2>
          {jobs.status === "ready" && <ReadAt value={jobs.data.generated_at} />}
        </div>
        {jobs.status === "loading" && <Loading what="jobs" />}
        {jobs.status === "error" && <ReportError error={jobs.error} onRetry={jobs.retry} />}
        {jobs.status === "ready" && jobs.data.jobs.length === 0 && (
          <div className="callout" role="status">
            <p>
              {cursors.length > 0
                ? "No more jobs on this page."
                : "No job with a usage record matches these filters."}
            </p>
            {address.jobId && (
              <p>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => address.jobId && openDetail(address.jobId)}
                >
                  Look this job ID up in any period
                </button>
              </p>
            )}
          </div>
        )}
        {jobs.status === "ready" && jobs.data.jobs.length > 0 && (
          <UsageJobsTable jobs={jobs.data.jobs} languages={languages} onOpen={openDetail} />
        )}
        {jobs.status === "ready" && (cursors.length > 0 || jobs.data.next_cursor) && (
          <nav className="usage-pager" aria-label="Job pages">
            <button
              type="button"
              className="button ghost"
              disabled={cursors.length === 0}
              onClick={() => setPages({ owner: identity, cursors: cursors.slice(0, -1) })}
            >
              Previous
            </button>
            <span className="small muted" aria-live="polite">
              Page {cursors.length + 1}
            </span>
            <button
              type="button"
              className="button ghost"
              disabled={!jobs.data.next_cursor}
              onClick={() => {
                const next = jobs.data.next_cursor;
                if (next) setPages({ owner: identity, cursors: [...cursors, next] });
              }}
            >
              Next
            </button>
          </nav>
        )}
      </section>

      {address.detail && (
        <UsageJobDetail
          key={address.detail}
          jobId={address.detail}
          refreshKey={refreshes}
          languages={languages}
          onClose={closeDetail}
          {...access}
        />
      )}
    </div>
  );
}
