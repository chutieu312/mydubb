import { useCallback, useEffect, useRef, useState } from "react";

import { authApi } from "./api/authApi";
import type { AuthUser } from "./api/authTypes";
import { ApiError, api, setCsrfToken } from "./api/client";
import type { AppMeta, Job } from "./api/types";
import { AppFooter } from "./components/AppFooter";
import { AppHeader } from "./components/AppHeader";
import { AccessGate } from "./features/access/AccessGate";
import { PasswordAuthFlow } from "./features/auth/PasswordAuthFlow";
import { DubbingForm } from "./features/dubbing/DubbingForm";
import { JobPanel } from "./features/jobs/JobPanel";
import { ProviderBanner } from "./features/providers/ProviderBanner";
import { authModeOf, passwordResetOf } from "./lib/authMode";
import { azureDisclosure, azureDisclosureShort } from "./lib/providers";
import { createDraftKeeper, type StudioDraft } from "./lib/studioDraft";
import { useTheme } from "./lib/useTheme";

type AuthState = "checking" | "anonymous" | "authenticated";

// The sign-in mode comes from GET /api/meta and nowhere else. If it is missing or unknown the
// page offers no way to sign in rather than guessing one.
const UNKNOWN_MODE = "We cannot tell how to sign you in right now. Please try again.";
const SESSION_CHECK_FAILED = "We could not check your session. Please try again.";

export function App() {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [auth, setAuth] = useState<AuthState>("checking");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loginKey, setLoginKey] = useState(0);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const logoutPending = useRef(false);
  const [theme, toggleTheme] = useTheme();
  const [drafts] = useState(createDraftKeeper);

  const mode = authModeOf(meta);
  const blockingError = loadError ?? (meta && mode === null ? UNKNOWN_MODE : null);

  useEffect(() => {
    let active = true;
    api
      .meta()
      .then((m) => active && setMeta(m))
      .catch((err: unknown) => {
        if (active) setLoadError(err instanceof ApiError ? err.message : "Failed to load.");
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  // Restore the session once the mode is known. Only the endpoint of that mode is ever called.
  useEffect(() => {
    if (mode === null) return;
    let active = true;
    const restore = async () => {
      if (mode === "cognito") {
        const session = await authApi.me();
        setCsrfToken(session.csrf_token);
        return session.user;
      }
      const session = await api.getSession();
      setCsrfToken(session.csrf_token);
      return null;
    };
    restore()
      .then((restored) => {
        if (!active) return;
        if (restored) drafts.reconcile(restored.id);
        setUser(restored);
        setAuth("authenticated");
      })
      .catch((err: unknown) => {
        if (!active) return;
        const signedOut = err instanceof ApiError && err.isUnauthenticated;
        if (mode === "cognito" && !signedOut) {
          // Not "signed out": the server could not be asked, so do not pretend either way.
          setLoadError(SESSION_CHECK_FAILED);
        } else {
          setAuth("anonymous");
        }
      });
    return () => {
      active = false;
    };
  }, [mode, drafts, attempt]);

  const retry = () => {
    setLoadError(null);
    setMeta(null);
    setAuth("checking");
    setAttempt((n) => n + 1);
  };

  // The session ended on the server's side (a 401 on a request). The unsent form stays in page
  // memory; it comes back only if the same user signs in again.
  const handleSessionExpired = useCallback(() => {
    setCsrfToken(null);
    setJobId(null);
    setUser(null);
    setLogoutError(null);
    setLoginKey((n) => n + 1);
    setAuth("anonymous");
    setSessionNotice(
      mode === "cognito"
        ? "Your session has expired or ended. Please sign in again."
        : "Your session has expired or ended. Please enter the Access Code again.",
    );
  }, [mode]);

  const handleAuthenticated = useCallback(
    (signedIn: AuthUser | null) => {
      if (signedIn) drafts.reconcile(signedIn.id);
      setSessionNotice(null);
      setUser(signedIn);
      setAuth("authenticated");
    },
    [drafts],
  );

  const rememberDraft = useCallback(
    (draft: StudioDraft) => {
      if (user) drafts.remember(user.id, draft);
    },
    [user, drafts],
  );

  const handleJobCreated = useCallback((job: Job) => setJobId(job.id), []);

  const signedOut = () => {
    // An explicit sign out (or a session the server confirms is gone) discards the draft.
    drafts.clear();
    setCsrfToken(null);
    setJobId(null);
    setUser(null);
    setLoginKey((n) => n + 1);
    setAuth("anonymous");
  };

  const logout = async () => {
    // A ref (not state) blocks a second click before React re-renders the disabled button.
    if (logoutPending.current) return;
    logoutPending.current = true;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await (mode === "cognito" ? authApi.logout() : api.logout());
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
        const action = mode === "cognito" ? "Sign out" : "Logout";
        setLogoutError(`${action} failed; you are still signed in.${detail} Please try again.`);
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
        user={user}
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
          {blockingError && (
            <div className="stack">
              <p className="callout error" role="alert">
                {blockingError}
              </p>
              <button type="button" className="button ghost" onClick={retry}>
                Try again
              </button>
            </div>
          )}
          {!blockingError && (auth === "checking" || !meta) && <p className="muted">Loading…</p>}
          {!blockingError && meta && auth === "anonymous" && mode === "access_code" && (
            <AccessGate notice={sessionNotice} onAuthenticated={() => handleAuthenticated(null)} />
          )}
          {!blockingError && meta && auth === "anonymous" && mode === "cognito" && (
            <PasswordAuthFlow
              key={loginKey}
              notice={sessionNotice}
              passwordReset={passwordResetOf(meta)}
              onAuthenticated={handleAuthenticated}
            />
          )}
          {!blockingError && auth === "authenticated" && meta && (
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
                youtubeImport={meta.youtube_import?.enabled === true}
                onJobCreated={handleJobCreated}
                onSessionExpired={handleSessionExpired}
                initialDraft={user ? drafts.draftFor(user.id) : undefined}
                onDraftChange={user ? rememberDraft : undefined}
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
