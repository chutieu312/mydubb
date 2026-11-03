import type { ServiceUsage, UsageSummary } from "../../api/usageApi";
import { formatCount, formatUtc, plainLabel, reasonLabel, serviceLabel } from "../../lib/usageFormat";
import { CostFigure, PartialNote, PriceLines, PriceSources, ReadAt } from "./usageParts";

function ServiceCard({ usage }: { usage: ServiceUsage }) {
  const outcomes = Object.entries(usage.outcomes).sort(([a], [b]) => a.localeCompare(b));
  return (
    <section className="panel usage-card" aria-label={`${serviceLabel(usage.service)} usage`}>
      <h2>{serviceLabel(usage.service)}</h2>
      <p className="usage-figure">
        {formatCount(usage.requests)}{" "}
        <span className="small muted">{usage.requests === 1 ? "request" : "requests"}</span>
      </p>
      <dl className="facts-list small">
        <dt>Actual</dt>
        <dd>
          {formatCount(usage.actual_characters)} chars ({formatCount(usage.actual_requests)} req.)
        </dd>
        <dt>Estimated</dt>
        <dd>
          {formatCount(usage.estimated_characters)} chars ({formatCount(usage.estimated_requests)}{" "}
          req.)
        </dd>
        <dt>Unknown</dt>
        <dd>
          {formatCount(usage.unknown_requests)} req.
          {usage.unknown_requests > 0 &&
            ` (${formatCount(usage.unknown_sent_characters)} chars sent: a size sent, not a billing figure)`}
        </dd>
        <dt>None</dt>
        <dd>{formatCount(usage.none_requests)} req.</dd>
        {usage.unpriced_characters > 0 && (
          <>
            <dt>No price</dt>
            <dd>{formatCount(usage.unpriced_characters)} chars known, no price for their date</dd>
          </>
        )}
      </dl>
      {outcomes.length > 0 && (
        <p className="small muted">
          {outcomes.map(([name, count]) => `${plainLabel(name)} ${formatCount(count)}`).join(", ")}
        </p>
      )}
    </section>
  );
}

export function UsageSummaryCards({ summary }: { summary: UsageSummary }) {
  const statuses = Object.entries(summary.statuses).sort(([a], [b]) => a.localeCompare(b));
  const reasons = Object.entries(summary.reasons).sort(([a], [b]) => a.localeCompare(b));
  const mockRequests = summary.services.reduce<[string, number][]>(
    (lines, usage) => [...lines, [serviceLabel(usage.service), usage.mock_requests]],
    [],
  );
  const unknownRequests = summary.services.map(
    (usage) => `${serviceLabel(usage.service)} ${formatCount(usage.unknown_requests)}`,
  );
  const unpriced = summary.services.filter((usage) => usage.unpriced_characters > 0);
  const cost = summary.reference_cost;

  return (
    <>
      <div className="usage-cards">
        <section className="panel usage-card" aria-label="Jobs with usage">
          <h2>Jobs with usage</h2>
          <p className="usage-figure">{formatCount(summary.jobs_total)}</p>
          {statuses.length > 0 && (
            <p className="small muted">
              {statuses.map(([name, count]) => `${plainLabel(name)} ${formatCount(count)}`).join(", ")}
            </p>
          )}
        </section>

        <section className="panel usage-card" aria-label="Completeness">
          <h2>Incomplete jobs</h2>
          <p className="usage-figure">
            {formatCount(summary.incomplete)}{" "}
            <span className="small muted">of {formatCount(summary.jobs_total)}</span>
          </p>
          {reasons.length > 0 && (
            <ul className="usage-lines small">
              {reasons.map(([reason, count]) => (
                <li key={reason}>
                  {reasonLabel(reason)}: {formatCount(count)}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel panel-coral usage-card" aria-label="Reference cost">
          <h2>Reference cost</h2>
          <p className="usage-figure">
            <CostFigure cost={cost} />
          </p>
          <PartialNote cost={cost} />
          <p className="small muted">
            Unknown requests: {unknownRequests.join(", ")}.
            {unpriced.length > 0 &&
              ` Known usage with no price: ${unpriced
                .map((u) => `${serviceLabel(u.service)} ${formatCount(u.unpriced_characters)} chars`)
                .join(", ")}.`}
          </p>
        </section>

        {summary.services.map((usage) => (
          <ServiceCard key={usage.service} usage={usage} />
        ))}

        <section className="panel usage-card" aria-label="Mock requests">
          <h2>Mock requests</h2>
          <p className="usage-figure">
            {formatCount(summary.jobs_with_mock)}{" "}
            <span className="small muted">{summary.jobs_with_mock === 1 ? "job" : "jobs"} with mock providers</span>
          </p>
          <p className="small muted">
            {mockRequests.map(([name, count]) => `${name} ${formatCount(count)}`).join(", ")}.
            Counted apart: never usage or cost.
          </p>
        </section>

        <section className="panel usage-card" aria-label="Jobs without a usage record">
          <h2>Jobs without a usage record</h2>
          <p className="usage-figure">{formatCount(summary.jobs_without_usage)}</p>
          <p className="small muted">
            Matched on when the job was created, since these have no usage start time. They are not
            free: they came before recording began, or the record could not be written.
          </p>
        </section>

        <section className="panel usage-card" aria-label="Earliest usage record">
          <h2>Earliest usage record</h2>
          <p className="usage-text">
            {summary.first_usage_at ? formatUtc(summary.first_usage_at) : "None in the database"}
          </p>
          <p className="small muted">
            The oldest record still in the database. It is not when recording was deployed:
            retention may have removed older ones.
          </p>
        </section>
      </div>

      <section className="panel panel-sand" aria-label="Reference prices used">
        <div className="panel-head">
          <h2>Reference prices used</h2>
          <ReadAt value={summary.generated_at} />
        </div>
        <PriceLines lines={cost.lines} />
        <PriceSources lines={cost.lines} />
      </section>
    </>
  );
}
