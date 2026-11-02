import { AppLink } from "../../components/AppLink";

export type AdminAccess = "none" | "checking" | "admin" | "denied" | "ended" | "failed";

/** What /admin/usage shows to anyone who is not (or not known to be) an administrator. */
export function AdminGate({ access, onRetry }: { access: AdminAccess; onRetry: () => void }) {
  if (access === "checking") {
    return (
      <p className="muted" role="status">
        Checking access…
      </p>
    );
  }
  return (
    <div className="stack">
      {access === "failed" && (
        <>
          <p className="callout error" role="alert">
            We could not check your administrator access. Please try again.
          </p>
          <div>
            <button type="button" className="button ghost" onClick={onRetry}>
              Try again
            </button>
          </div>
        </>
      )}
      {access === "ended" && (
        <p className="callout warning" role="alert">
          Your administrator access has ended, so the usage report was removed from this page. You
          are still signed in.
        </p>
      )}
      {(access === "denied" || access === "none") && (
        <p className="callout" role="status">
          This page is for MyDubb administrators.
        </p>
      )}
      <p>
        <AppLink href="/" className="link-button">
          Back to Studio
        </AppLink>
      </p>
    </div>
  );
}
