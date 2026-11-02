import { useState, type FormEvent } from "react";

import type { TargetLanguageOption } from "../../api/types";
import type { UsageFilters } from "../../api/usageApi";
import {
  fromFieldValue,
  toFieldValue,
  validateDraft,
  type FilterDraft,
  type FilterErrors,
} from "../../lib/usageFilters";
import { FieldMessage } from "../dubbing/FieldMessage";

interface Props {
  applied: UsageFilters;
  languages: TargetLanguageOption[];
  onApply: (filters: UsageFilters) => void;
  onRefresh: () => void;
}

const draftOf = (filters: UsageFilters): FilterDraft => ({
  since: toFieldValue(filters.since),
  until: toFieldValue(filters.until),
  language: filters.language ?? "",
  jobId: filters.jobId ?? "",
});

const sameFilters = (a: UsageFilters, b: UsageFilters) =>
  a.since === b.since &&
  a.until === b.until &&
  (a.language ?? "") === (b.language ?? "") &&
  (a.jobId ?? "") === (b.jobId ?? "");

/** Nothing is asked of the server while typing: only Apply and Refresh do. */
export function UsageFiltersForm({ applied, languages, onApply, onRefresh }: Props) {
  const [draft, setDraft] = useState(() => draftOf(applied));
  const [errors, setErrors] = useState<FilterErrors>({});
  // Back/Forward or a Refresh changed what is applied: the form shows it again.
  const [shown, setShown] = useState(applied);
  if (!sameFilters(shown, applied)) {
    setShown(applied);
    setDraft(draftOf(applied));
    setErrors({});
  }

  const change = (name: keyof FilterDraft, value: string) => {
    setDraft((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    onApply({
      since: fromFieldValue(draft.since),
      until: fromFieldValue(draft.until),
      language: draft.language || undefined,
      jobId: draft.jobId.trim() || undefined,
    });
  };

  const field = (name: keyof FilterDraft) => ({
    "aria-invalid": Boolean(errors[name]),
    "aria-describedby": errors[name] ? `usage-${name}-error` : undefined,
  });

  return (
    <form className="panel panel-sky" onSubmit={submit} noValidate aria-label="Usage filters">
      <div className="usage-filter-fields">
        <div className="field">
          <label htmlFor="usage-since">Since (UTC, inclusive)</label>
          <input
            id="usage-since"
            type="datetime-local"
            step={1}
            value={draft.since}
            onChange={(e) => change("since", e.target.value)}
            {...field("since")}
          />
          <FieldMessage id="usage-since-error" message={errors.since} />
        </div>
        <div className="field">
          <label htmlFor="usage-until">Until (UTC, exclusive)</label>
          <input
            id="usage-until"
            type="datetime-local"
            step={1}
            value={draft.until}
            onChange={(e) => change("until", e.target.value)}
            {...field("until")}
          />
          <FieldMessage id="usage-until-error" message={errors.until} />
        </div>
        <div className="field">
          <label htmlFor="usage-language">Language</label>
          <select
            id="usage-language"
            value={draft.language}
            onChange={(e) => change("language", e.target.value)}
          >
            <option value="">All languages</option>
            {languages.map((language) => (
              <option key={language.id} value={language.id}>
                {language.label}
              </option>
            ))}
            {draft.language && !languages.some((l) => l.id === draft.language) && (
              <option value={draft.language}>{draft.language}</option>
            )}
          </select>
        </div>
        <div className="field">
          <label htmlFor="usage-job">Job ID</label>
          <input
            id="usage-job"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={draft.jobId}
            onChange={(e) => change("jobId", e.target.value)}
            {...field("jobId")}
          />
          <FieldMessage id="usage-jobId-error" message={errors.jobId} />
        </div>
      </div>
      <p className="small muted">
        The period filters on when the job started (<code>since &lt;= started &lt; until</code>), at
        most 31 days at a time.
      </p>
      <div className="usage-filter-actions">
        <button type="submit" className="button primary">
          Apply
        </button>
        <button type="button" className="button ghost" onClick={onRefresh}>
          Refresh
        </button>
      </div>
    </form>
  );
}
