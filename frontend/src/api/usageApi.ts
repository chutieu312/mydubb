import { request } from "./client";

// Usage & Costs (docs/AUTH_API.md). Money is an exact decimal string from the server:
// the page formats it and never computes with it.

export interface UsageFilters {
  since: string;
  until: string;
  language?: string;
  jobId?: string;
}

export interface AppliedFilters {
  since: string;
  until: string;
  language: string | null;
  job_id: string | null;
}

export interface ServiceUsage {
  service: string;
  requests: number;
  mock_requests: number;
  actual_requests: number;
  actual_characters: number;
  estimated_requests: number;
  estimated_characters: number;
  unknown_requests: number;
  unknown_sent_characters: number;
  none_requests: number;
  outcomes: Record<string, number>;
  unpriced_characters: number;
  reference_cost: string;
}

export interface PriceLine {
  service: string;
  sku: string;
  meter: string;
  region: string;
  unit: string;
  price: string;
  currency: string;
  effective_from: string;
  checked_on: string;
  source: string;
  characters: number;
  amount: string;
}

export interface ReferenceCost {
  currency: string;
  known_total: string;
  partial: boolean;
  partial_reasons: string[];
  lines: PriceLine[];
}

export interface UsageSummary {
  generated_at: string;
  filters: AppliedFilters;
  first_usage_at: string | null;
  jobs_total: number;
  statuses: Record<string, number>;
  complete: number;
  incomplete: number;
  reasons: Record<string, number>;
  jobs_with_mock: number;
  jobs_without_usage: number;
  services: ServiceUsage[];
  reference_cost: ReferenceCost;
}

export interface UsageJob {
  job_id: string;
  started_at: string;
  finished_at: string | null;
  language: string;
  voice: string;
  speed_percent: number;
  timing_mode: string;
  status: string;
  outcome: string | null;
  error_code: string | null;
  providers: string;
  complete: boolean;
  reasons: string[];
  services: ServiceUsage[];
  reference_cost: ReferenceCost;
  baseline_seconds: number;
  target_audio_seconds: string;
  final_audio_seconds: string | null;
  audio_processing_ms: number | null;
  mp3_bytes: number | null;
}

export interface UsageJobsPage {
  generated_at: string;
  filters: AppliedFilters;
  jobs: UsageJob[];
  next_cursor: string | null;
}

export interface UsageAttempt {
  seq: number;
  service: string;
  provider_kind: string;
  outcome: string;
  http_status: number | null;
  error_code: string | null;
  started_at: string;
  elapsed_ms: number;
  usage_amount: number | null;
  usage_unit: string;
  usage_basis: string;
  usage_method: string | null;
  reference_cost: string | null;
  no_cost_reason: string | null;
}

export interface UsageJobDetail {
  generated_at: string;
  job: UsageJob;
  method_version: number;
  attempts_total: number;
  attempts: UsageAttempt[];
  next_cursor: string | null;
}

function url(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

const filterParams = (filters: UsageFilters) => ({
  since: filters.since,
  until: filters.until,
  language: filters.language,
  job_id: filters.jobId,
});

export const usageApi = {
  adminSession: (signal?: AbortSignal) =>
    request<{ role: string }>("GET", "/api/admin/session", { signal }),
  summary: (filters: UsageFilters, signal?: AbortSignal) =>
    request<UsageSummary>("GET", url("/api/admin/usage/summary", filterParams(filters)), {
      signal,
    }),
  jobs: (filters: UsageFilters, cursor: string | undefined, signal?: AbortSignal) =>
    request<UsageJobsPage>(
      "GET",
      url("/api/admin/usage/jobs", { ...filterParams(filters), cursor }),
      { signal },
    ),
  job: (jobId: string, cursor: string | undefined, signal?: AbortSignal) =>
    request<UsageJobDetail>(
      "GET",
      url(`/api/admin/usage/jobs/${encodeURIComponent(jobId)}`, { cursor }),
      { signal },
    ),
};
