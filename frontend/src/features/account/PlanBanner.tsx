import { planName, type AccountUsage, type KindUsage } from "../../api/accountApi";

interface Props {
  usage: AccountUsage;
  // The server offers YouTube import (GET /api/meta); otherwise imports are not mentioned.
  youtubeImport: boolean;
}

// The reset instant in the reader's own time zone, next to the UTC rule.
const localTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));

const left = (usage: KindUsage, one: string, many: string) =>
  `${usage.remaining ?? 0} of ${usage.limit ?? 0} ${usage.limit === 1 ? one : many} left today`;

/** Today's limits of the signed-in account; numbers from the server only. */
export function PlanBanner({ usage, youtubeImport }: Props) {
  if (usage.exempt) {
    return (
      <section className="callout plan-banner" aria-label="Your plan">
        <p className="small">
          No daily MyDubb limits apply to your account. The server&apos;s capacity still does.
        </p>
      </section>
    );
  }
  const plan = planName(usage.plan);
  const jobsUsedUp = usage.generate.remaining === 0;
  const importsUsedUp = youtubeImport && usage.youtube_import.remaining === 0;
  return (
    <section className="callout plan-banner" aria-label="Your plan">
      <p>
        <strong>{plan} plan.</strong> {left(usage.generate, "audio job", "audio jobs")}
        {youtubeImport && ` · ${left(usage.youtube_import, "YouTube import", "YouTube imports")}`}.
      </p>
      {usage.max_words !== null && usage.max_output_seconds !== null && (
        <p className="small muted">
          Each job: up to {usage.max_words.toLocaleString("en-US")} words and{" "}
          {Math.round(usage.max_output_seconds / 60)} minutes of audio. A job or import counts
          when MyDubb accepts it, even if it fails later.
        </p>
      )}
      {jobsUsedUp && (
        <p role="status">
          You have used today&apos;s {usage.generate.limit} audio jobs. Jobs you started keep
          running and your audio stays available.
        </p>
      )}
      {importsUsedUp && (
        <p role="status">
          You have used today&apos;s {usage.youtube_import.limit} YouTube imports. You can still
          paste a transcript.
        </p>
      )}
      <p className="small muted">
        Counts start again at 00:00 UTC ({localTime(usage.resets_at)}).
      </p>
    </section>
  );
}
