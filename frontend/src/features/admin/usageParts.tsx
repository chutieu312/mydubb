import type { ReactNode } from "react";

import type { ApiError } from "../../api/client";
import type { PriceLine, ReferenceCost, ServiceUsage } from "../../api/usageApi";
import { formatCount, formatMoney, formatUtc, partialReasonLabel, reasonLabel, serviceLabel } from "../../lib/usageFormat";

export function Utc({ value }: { value: string }) {
  return <time dateTime={value}>{formatUtc(value)}</time>;
}

/** A value that was not recorded: never shown as 0. */
export function NotRecorded() {
  return (
    <span title="Not recorded">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not recorded</span>
    </span>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="muted" role="status">
      Loading {what}…
    </p>
  );
}

export function ReportError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  if (error.fields.length > 0) {
    return (
      <div className="callout error" role="alert">
        <p>These filters cannot be used. Change them above.</p>
        <ul className="notes">
          {error.fields.map((field) => (
            <li key={field.field}>
              {field.field}: {field.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="usage-error stack">
      <p className="callout error" role="alert">
        {error.message}
      </p>
      <button type="button" className="button ghost" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function ReadAt({ value }: { value: string }) {
  return (
    <p className="small muted">
      Read at <Utc value={value} />
    </p>
  );
}

/** The characters of one service, by how they are known. The two services are never added up. */
export function ServiceFigures({ usage }: { usage: ServiceUsage }) {
  const lines: ReactNode[] = [];
  if (usage.actual_requests > 0)
    lines.push(`${formatCount(usage.actual_characters)} chars actual`);
  if (usage.estimated_requests > 0)
    lines.push(`${formatCount(usage.estimated_characters)} chars estimated`);
  if (usage.unknown_requests > 0)
    lines.push(`${formatCount(usage.unknown_requests)} unknown req.`);
  if (usage.none_requests > 0) lines.push(`${formatCount(usage.none_requests)} none req.`);
  if (usage.mock_requests > 0) lines.push(`${formatCount(usage.mock_requests)} mock req.`);
  if (usage.unpriced_characters > 0)
    lines.push(`${formatCount(usage.unpriced_characters)} chars unpriced`);
  if (lines.length === 0) return <span className="muted">No requests</span>;
  return (
    <ul className="usage-lines">
      {lines.map((line, index) => (
        <li key={index}>{line}</li>
      ))}
    </ul>
  );
}

export function CostFigure({ cost }: { cost: ReferenceCost }) {
  return (
    <span title={`Exact: ${cost.known_total} ${cost.currency}`}>
      {cost.partial && <span className="small">at least </span>}
      <strong>
        {cost.currency} {formatMoney(cost.known_total)}
      </strong>
    </span>
  );
}

export function PartialNote({ cost }: { cost: ReferenceCost }) {
  if (!cost.partial) return null;
  return (
    <p className="small">
      A lower bound of known usage, not a total: {cost.partial_reasons.map(partialReasonLabel).join(", ")}.
    </p>
  );
}

export function ReasonList({ reasons }: { reasons: string[] }) {
  return (
    <ul className="usage-lines">
      {reasons.map((reason) => (
        <li key={reason}>{reasonLabel(reason)}</li>
      ))}
    </ul>
  );
}

/** Each price in force gets its own line: a period can span several, and none stands for all. */
export function PriceLines({ lines }: { lines: PriceLine[] }) {
  if (lines.length === 0) {
    return <p className="small muted">No usage with a reference price here.</p>;
  }
  return (
    <div className="usage-table-wrap">
      <table className="usage-table" role="table">
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">Service</th>
            <th scope="col" role="columnheader">Price</th>
            <th scope="col" role="columnheader">SKU and region</th>
            <th scope="col" role="columnheader">Effective</th>
            <th scope="col" role="columnheader">Checked</th>
            <th scope="col" role="columnheader">Characters</th>
            <th scope="col" role="columnheader">Reference cost</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {lines.map((line) => (
            <tr role="row" key={`${line.service}-${line.effective_from}-${line.sku}-${line.region}`}>
              <td role="cell" data-label="Service">{serviceLabel(line.service)}</td>
              <td role="cell" data-label="Price">
                {line.currency} {line.price} / {line.unit}
              </td>
              <td role="cell" data-label="SKU and region">
                {line.sku}, {line.region}
                <span className="block small muted">{line.meter}</span>
              </td>
              <td role="cell" data-label="Effective">{line.effective_from}</td>
              <td role="cell" data-label="Checked">{line.checked_on}</td>
              <td role="cell" data-label="Characters">{formatCount(line.characters)}</td>
              <td role="cell" data-label="Reference cost" title={`Exact: ${line.amount} ${line.currency}`}>
                {line.currency} {formatMoney(line.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PriceSources({ lines }: { lines: PriceLine[] }) {
  if (lines.length === 0) return null;
  const sources = [...new Set(lines.map((line) => line.source))];
  return (
    <details className="disclosure plain">
      <summary>Price sources</summary>
      <ul className="notes small usage-sources">
        {sources.map((source) => (
          <li key={source}>{source}</li>
        ))}
      </ul>
    </details>
  );
}
