import { guestJobsLeft, type GuestQuota } from "../../api/guestApi";
import { guestLimitText } from "../../lib/guestQuota";

interface Props {
  quota: GuestQuota;
  onSignIn: () => void;
  leaving: boolean;
}

export function GuestBanner({ quota, onSignIn, leaving }: Props) {
  const left = guestJobsLeft(quota);
  const limit = guestLimitText(quota);
  const hours = quota.ip_window_seconds / 3600;
  return (
    <section className="callout guest-banner" aria-label="Guest mode">
      <p>
        <strong>Guest mode.</strong> {left} {left === 1 ? "job" : "jobs"} left · up to{" "}
        {quota.max_words.toLocaleString("en-US")} words per job.
      </p>
      {limit ? (
        <p role="status">{limit}</p>
      ) : (
        <p className="small muted">
          A guest session has {quota.session_limit} jobs, and guests on the same network share{" "}
          {quota.ip_limit} jobs per {hours} hours. Only completed jobs count. YouTube import needs
          an account.
        </p>
      )}
      <p>
        <button type="button" className="link-button" onClick={onSignIn} disabled={leaving}>
          {leaving ? "Leaving guest mode…" : "Sign in with an invitation"}
        </button>
      </p>
    </section>
  );
}
