import { guestImportsLeft, guestJobsLeft, type GuestImportQuota, type GuestQuota } from "../../api/guestApi";
import { guestImportLimitText, guestLimitText } from "../../lib/guestQuota";

interface Props {
  quota: GuestQuota;
  // YouTube imports, counted apart from the audio jobs; null when this server has no import.
  imports: GuestImportQuota | null;
  onSignIn: () => void;
  leaving: boolean;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function GuestBanner({ quota, imports, onSignIn, leaving }: Props) {
  const left = guestJobsLeft(quota);
  const limit = guestLimitText(quota);
  const importLimit = imports ? guestImportLimitText(imports, quota.ip_window_seconds) : null;
  const hours = quota.ip_window_seconds / 3600;
  return (
    <section className="callout guest-banner" aria-label="Guest mode">
      <p>
        <strong>Guest mode.</strong> {plural(left, "audio job", "audio jobs")} left · up to{" "}
        {quota.max_words.toLocaleString("en-US")} words and {Math.round(quota.max_output_seconds / 60)} minutes of
        audio per job.
      </p>
      {imports && (
        <p>
          {plural(guestImportsLeft(imports), "YouTube import", "YouTube imports")} left · counted
          separately: importing never uses an audio job.
        </p>
      )}
      {limit && <p role="status">{limit}</p>}
      {importLimit && <p role="status">{importLimit}</p>}
      {!limit && !importLimit && (
        <p className="small muted">
          A guest session has {quota.session_limit} audio jobs, and guests on the same network
          share {quota.ip_limit} jobs per {hours} hours. Only completed jobs count.{" "}
          {imports
            ? `YouTube imports: ${imports.session_limit} per session and ${imports.ip_limit} per network in the same ${hours} hours; only successful imports count.`
            : "YouTube import needs an account."}
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
