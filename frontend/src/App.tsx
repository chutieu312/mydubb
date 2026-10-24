import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api, setCsrfToken } from "./api/client";
import type { AppMeta, Job } from "./api/types";
import { AppFooter } from "./components/AppFooter";
import { AppHeader } from "./components/AppHeader";
import { AccessGate } from "./features/access/AccessGate";
import { DubbingForm } from "./features/dubbing/DubbingForm";
import { JobPanel } from "./features/jobs/JobPanel";
import { ProviderBanner } from "./features/providers/ProviderBanner";
import { azureDisclosure, azureDisclosureShort } from "./lib/providers";
import { useTheme } from "./lib/useTheme";

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
  const [theme, toggleTheme] = useTheme();

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
      <AppHeader
        theme={theme}
        onToggleTheme={toggleTheme}
        signedIn={auth === "authenticated"}
        loggingOut={loggingOut}
        onLogout={logout}
      />

      <div className="page">
        {auth === "authenticated" && logoutError && (
          <p className="callout error" role="alert">
            {logoutError}
          </p>
        )}

        {meta && <ProviderBanner providers={meta.providers} />}

        <main className="main">
          {loadError && (
            <p className="callout error" role="alert">
              {loadError}
            </p>
          )}
          {auth === "checking" && <p className="muted">Loading…</p>}
          {auth === "anonymous" && (
            <AccessGate notice={sessionNotice} onAuthenticated={handleAuthenticated} />
          )}
          {auth === "authenticated" && meta && (
            <>
              <section className="hero">
                <p className="eyebrow">Your dubbing studio</p>
                <h1>Turn English into Vietnamese audio</h1>
                <p className="muted">
                  Paste a transcript, choose a voice and speed, then listen and download the MP3.
                </p>
              </section>
              <DubbingForm
                voices={meta.voices}
                disclosure={azureDisclosureShort(meta.providers)}
                onJobCreated={handleJobCreated}
                onSessionExpired={handleSessionExpired}
              />
              {jobId && (
                <JobPanel
                  key={jobId}
                  jobId={jobId}
                  voices={meta.voices}
                  onSessionExpired={handleSessionExpired}
                />
              )}
            </>
          )}
        </main>

        {meta && (
          <AppFooter
            disclosure={azureDisclosure(meta.providers)}
            resultTtlSeconds={meta.result_ttl_seconds}
          />
        )}
      </div>
    </div>
  );
}
