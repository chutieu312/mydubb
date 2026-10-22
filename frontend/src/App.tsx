import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api, setCsrfToken } from "./api/client";
import type { AppMeta, Job } from "./api/types";
import { AccessGate } from "./features/access/AccessGate";
import { DubbingForm } from "./features/dubbing/DubbingForm";
import { JobPanel } from "./features/jobs/JobPanel";

type AuthState = "checking" | "anonymous" | "authenticated";

export function App() {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [auth, setAuth] = useState<AuthState>("checking");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const logoutPending = useRef(false);

  useEffect(() => {
    let active = true;
    api
      .meta()
      .then((m) => active && setMeta(m))
      .catch((err: unknown) => {
        if (active) setLoadError(err instanceof ApiError ? err.message : "Failed to load.");
      });
    api
      .getSession()
      .then((session) => {
        if (!active) return;
        setCsrfToken(session.csrf_token);
        setAuth("authenticated");
      })
      .catch(() => active && setAuth("anonymous"));
    return () => {
      active = false;
    };
  }, []);

  const handleSessionExpired = useCallback(() => {
    setCsrfToken(null);
    setJobId(null);
    setLogoutError(null);
    setAuth("anonymous");
    setSessionNotice("Your session has expired or ended. Please enter the Access Code again.");
  }, []);

  const handleAuthenticated = useCallback(() => {
    setSessionNotice(null);
    setAuth("authenticated");
  }, []);

  const handleJobCreated = useCallback((job: Job) => setJobId(job.id), []);

  const signedOut = () => {
    setCsrfToken(null);
    setJobId(null);
    setAuth("anonymous");
  };

  const logout = async () => {
    // A ref (not state) blocks a second click before React re-renders the disabled button.
    if (logoutPending.current) return;
    logoutPending.current = true;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await api.logout();
      signedOut();
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthenticated) {
        // The server confirms there is no valid session any more.
        signedOut();
      } else {
        // Network, 5xx or CSRF failures do not prove the server session ended, and the
        // HttpOnly cookie cannot be cleared from JavaScript. Stay signed in, keep the CSRF
        // token, and let the user retry.
        const detail = err instanceof ApiError ? ` ${err.message}` : "";
        setLogoutError(`Logout failed; you are still signed in.${detail} Please try again.`);
      }
    } finally {
      logoutPending.current = false;
      setLoggingOut(false);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>
          MyDubb <span className="subtitle">Transcript to Vietnamese Voice</span>
        </h1>
        {auth === "authenticated" && (
          <button type="button" className="secondary" onClick={logout} disabled={loggingOut}>
            {loggingOut ? "Logging out…" : "Log out"}
          </button>
        )}
      </header>
      {auth === "authenticated" && logoutError && (
        <p className="error" role="alert">
          {logoutError}
        </p>
      )}

      {meta?.mock_mode && (
        <div className="mock-banner" role="status">
          <strong>Development mock mode.</strong> No Azure services are called. Translations
          are illustrative placeholders and the audio is a fixed sample, not generated from your
          transcript.
        </div>
      )}

      <main className="main">
        {loadError && (
          <p className="error" role="alert">
            {loadError}
          </p>
        )}
        {sessionNotice && <p className="warning">{sessionNotice}</p>}
        {auth === "checking" && <p>Loading…</p>}
        {auth === "anonymous" && <AccessGate onAuthenticated={handleAuthenticated} />}
        {auth === "authenticated" && meta && (
          <>
            <DubbingForm
              voices={meta.voices}
              onJobCreated={handleJobCreated}
              onSessionExpired={handleSessionExpired}
            />
            {jobId && (
              <JobPanel key={jobId} jobId={jobId} onSessionExpired={handleSessionExpired} />
            )}
          </>
        )}
      </main>

      <footer className="footer muted">
        <small>
          Private beta. Transcripts are processed temporarily and are not stored permanently.
        </small>
      </footer>
    </div>
  );
}
