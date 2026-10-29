import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { authApi } from "./api/authApi";
import type { AuthUser } from "./api/authTypes";
import { ApiError, api, setCsrfToken } from "./api/client";
import { guestApi, type GuestSession } from "./api/guestApi";
import type { AppMeta, Job } from "./api/types";
import { AppFooter } from "./components/AppFooter";
import { AppHeader } from "./components/AppHeader";
import { AccessGate } from "./features/access/AccessGate";
import { PasswordAuthFlow } from "./features/auth/PasswordAuthFlow";
import { DubbingForm } from "./features/dubbing/DubbingForm";
import { GuestBanner } from "./features/guest/GuestBanner";
import { JobPanel } from "./features/jobs/JobPanel";
import { ProviderBanner } from "./features/providers/ProviderBanner";
import { authModeOf, guestAccessOf, passwordResetOf } from "./lib/authMode";
import { languageChoiceOf, languageNouns } from "./lib/languages";
import { azureDisclosure, azureDisclosureShort } from "./lib/providers";
import { createDraftKeeper, type StudioDraft } from "./lib/studioDraft";
import { useTheme } from "./lib/useTheme";

// "guest": a guest session ("Try as guest"), which is not an account and owns its own jobs.
type AuthState = "checking" | "anonymous" | "authenticated" | "guest";

// The sign-in mode comes from GET /api/meta and nowhere else. If it is missing or unknown the
// page offers no way to sign in rather than guessing one.
const UNKNOWN_MODE = "We cannot tell how to sign you in right now. Please try again.";
const SESSION_CHECK_FAILED = "We could not check your session. Please try again.";
const GUEST_START_FAILED = "We could not start a guest session. Please try again.";
const GUEST_START_REFUSALS = new Set([
  "guest_sessions_exhausted",
  "guest_network_unknown",
  "guest_access_disabled",
  "already_signed_in",
]);

type Restored =
  | { kind: "user"; user: AuthUser | null; csrf: string }
  | { kind: "guest"; guest: GuestSession; csrf: string };

// Drafts are kept per identity: a guest's draft never appears for an account, nor the reverse.
const guestOwner = (guest: GuestSession) => `guest:${guest.guest.id}`;

export function App() {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [auth, setAuth] = useState<AuthState>("checking");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [guest, setGuest] = useState<GuestSession | null>(null);
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

  // Identity generation. Every change of who is using the page (session restored, sign in, sign
  // out, session ended, guest session started) starts a new one. The answer to a request sent
  // under an older generation, success or error, is ignored: a late 401 of a guest request must
  // not sign out the account that signed in since, and a late guest quota must not replace the
  // quota of a newer guest session. `identity` mirrors it in state so the callbacks handed to
  // child components are bound to the generation they were rendered for.
  const generation = useRef(0);
  const [identity, setIdentity] = useState(0);
  const nextIdentity = useCallback(() => {
    generation.current += 1;
    setIdentity(generation.current);
    // A sign out still in flight belongs to the previous identity.
    logoutPending.current = false;
    setLoggingOut(false);
  }, []);
  const isCurrent = useCallback((gen: number) => generation.current === gen, []);

  const mode = authModeOf(meta);
  const guestEnabled = guestAccessOf(meta);
  const blockingError = loadError ?? (meta && mode === null ? UNKNOWN_MODE : null);
  const draftOwner = user ? user.id : guest ? guestOwner(guest) : null;

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

  // Restore the session once the mode is known. Only the endpoints of that mode are ever called:
  // an account session first, then (if offered) a guest session.
  useEffect(() => {
    if (mode === null) return;
    let active = true;
    const gen = generation.current;
    const current = () => active && isCurrent(gen);
    const restore = async (): Promise<Restored> => {
      if (mode === "cognito") {
        try {
          const session = await authApi.me();
          return { kind: "user", user: session.user, csrf: session.csrf_token };
        } catch (err) {
          if (!(guestEnabled && err instanceof ApiError && err.isUnauthenticated)) throw err;
        }
        const found = await guestApi.get();
        return { kind: "guest", guest: found, csrf: found.csrf_token };
      }
      const session = await api.getSession();
      return { kind: "user", user: null, csrf: session.csrf_token };
    };
    restore()
      .then((restored) => {
        if (!current()) return;
        // The CSRF token is kept only once the answer is known to belong to this page state.
        setCsrfToken(restored.csrf);
        nextIdentity();
        if (restored.kind === "guest") {
          drafts.reconcile(guestOwner(restored.guest));
          setGuest(restored.guest);
          setAuth("guest");
          return;
        }
        if (restored.user) drafts.reconcile(restored.user.id);
        setUser(restored.user);
        setAuth("authenticated");
      })
      .catch((err: unknown) => {
        if (!current()) return;
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
  }, [mode, guestEnabled, drafts, attempt, isCurrent, nextIdentity]);

  const retry = () => {
    setLoadError(null);
    setMeta(null);
    setAuth("checking");
    setAttempt((n) => n + 1);
  };

  // The session ended on the server's side (a 401 on a request of the current identity). The
  // unsent form stays in page memory; it comes back only if the same user (or the same guest
  // session) signs in again.
  const expireSession = useCallback(() => {
    const wasGuest = auth === "guest";
    nextIdentity();
    setCsrfToken(null);
    setJobId(null);
    setUser(null);
    setGuest(null);
    setLogoutError(null);
    setLoginKey((n) => n + 1);
    setAuth("anonymous");
    setSessionNotice(
      wasGuest
        ? "Your guest session has ended. Sign in with your invitation, or try as a guest again."
        : mode === "cognito"
          ? "Your session has expired or ended. Please sign in again."
          : "Your session has expired or ended. Please enter the Access Code again.",
    );
  }, [mode, auth, nextIdentity]);

  const handleAuthenticated = useCallback(
    (signedIn: AuthUser | null) => {
      nextIdentity();
      if (signedIn) drafts.reconcile(signedIn.id);
      setSessionNotice(null);
      setGuest(null);
      setUser(signedIn);
      setAuth("authenticated");
    },
    [drafts, nextIdentity],
  );

  const startGuest = useCallback(async (): Promise<string | null> => {
    const gen = generation.current;
    try {
      const started = await guestApi.start();
      // The page moved on meanwhile (the sign-in form is disabled while this runs, so this is a
      // safety net): the answer belongs to nobody on screen.
      if (!isCurrent(gen)) return null;
      nextIdentity();
      setCsrfToken(started.csrf_token);
      drafts.reconcile(guestOwner(started));
      setSessionNotice(null);
      setUser(null);
      setGuest(started);
      setAuth("guest");
      return null;
    } catch (err) {
      if (!isCurrent(gen)) return null;
      if (!(err instanceof ApiError)) return GUEST_START_FAILED;
      // The client's own "cannot reach the server", or a refusal whose message the server writes
      // for the user. Anything else gets a generic message.
      if (err.status === 0 || GUEST_START_REFUSALS.has(err.code)) return err.message;
      return GUEST_START_FAILED;
    }
  }, [drafts, isCurrent, nextIdentity]);

  // Remaining guest jobs and imports come from the server only; refreshed after each submission,
  // job end and import, and applied only within the generation (and to the guest session) that
  // asked.
  const refreshGuest = useCallback(
    (gen: number) => {
      guestApi
        .get()
        .then((current) => {
          if (!isCurrent(gen)) return;
          setGuest((previous) =>
            previous && previous.guest.id === current.guest.id ? current : previous,
          );
        })
        .catch((err: unknown) => {
          if (!isCurrent(gen)) return;
          if (err instanceof ApiError && err.isUnauthenticated) expireSession();
          // Otherwise keep the last known numbers; the server still enforces the quota.
        });
    },
    [isCurrent, expireSession],
  );

  // Callbacks for child components, bound to the identity they were rendered for: when a request
  // a component sent before an identity change answers, it cannot act on the new identity.
  const bound = useMemo(() => {
    const gen = identity;
    const guestMode = auth === "guest";
    return {
      sessionExpired: () => {
        if (isCurrent(gen)) expireSession();
      },
      jobCreated: (job: Job) => {
        if (!isCurrent(gen)) return;
        setJobId(job.id);
        if (guestMode) refreshGuest(gen);
      },
      guestChanged: () => {
        if (isCurrent(gen)) refreshGuest(gen);
      },
    };
  }, [identity, auth, isCurrent, expireSession, refreshGuest]);

  const rememberDraft = useCallback(
    (draft: StudioDraft) => {
      if (draftOwner) drafts.remember(draftOwner, draft);
    },
    [draftOwner, drafts],
  );

  const signedOut = () => {
    // An explicit sign out (or a session the server confirms is gone) discards the draft.
    nextIdentity();
    drafts.clear();
    setCsrfToken(null);
    setJobId(null);
    setUser(null);
    setGuest(null);
    setLoginKey((n) => n + 1);
    setAuth("anonymous");
  };

  const logout = async () => {
    // A ref (not state) blocks a second click before React re-renders the disabled button.
    if (logoutPending.current) return;
    logoutPending.current = true;
    const gen = generation.current;
    const leavingGuest = auth === "guest";
    setLoggingOut(true);
    setLogoutError(null);
    try {
      if (leavingGuest) await guestApi.end();
      else await (mode === "cognito" ? authApi.logout() : api.logout());
      // If the session already ended another way, someone else may be signed in by now.
      if (isCurrent(gen)) signedOut();
    } catch (err) {
      if (!isCurrent(gen)) return;
      if (err instanceof ApiError && err.isUnauthenticated) {
        // The server confirms there is no valid session any more.
        signedOut();
      } else {
        // Network, 5xx or CSRF failures do not prove the server session ended, and the
        // HttpOnly cookie cannot be cleared from JavaScript. Stay signed in, keep the CSRF
        // token, and let the user retry.
        const detail = err instanceof ApiError ? ` ${err.message}` : "";
        setLogoutError(
          leavingGuest
            ? `Leaving guest mode failed; your guest session is still active.${detail} Please try again.`
            : `${mode === "cognito" ? "Sign out" : "Logout"} failed; you are still signed in.${detail} Please try again.`,
        );
      }
    } finally {
      // After an identity change the new identity owns this state (reset by nextIdentity).
      if (isCurrent(gen)) {
        logoutPending.current = false;
        setLoggingOut(false);
      }
    }
  };

  const inStudio = auth === "authenticated" || auth === "guest";
  const guestLimits = meta?.guest_access;
  // "Translate to": the output languages the server offers (none listed: Vietnamese only).
  const languages = useMemo(
    () => (meta ? languageChoiceOf(meta) : { options: [], defaultId: "" }),
    [meta],
  );
  const languageList = languageNouns(languages.options);
  // A guest's YouTube imports (null: the server offers none to this guest).
  const guestImports = auth === "guest" && guest ? guest.imports : null;

  return (
    <div className="app">
      <AppHeader
        theme={theme}
        onToggleTheme={toggleTheme}
        signedIn={auth === "authenticated"}
        user={user}
        guest={auth === "guest"}
        loggingOut={loggingOut}
        onLogout={logout}
      />

      <div className="page">
        {inStudio && logoutError && (
          <p className="callout error" role="alert">
            {logoutError}
          </p>
        )}

        {meta && <ProviderBanner providers={meta.providers} languages={languageList} />}

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
              guest={
                guestEnabled
                  ? {
                      onTry: startGuest,
                      jobsPerSession: guestLimits?.jobs_per_session ?? 0,
                      maxWords: guestLimits?.max_words ?? 0,
                      maxOutputSeconds: guestLimits?.max_output_seconds ?? 0,
                    }
                  : undefined
              }
              onAuthenticated={handleAuthenticated}
            />
          )}
          {!blockingError && inStudio && meta && (
            <>
              <section className="hero">
                <p className="eyebrow">Your dubbing studio</p>
                <h1>Turn English into {languageList} audio</h1>
                <p className="muted">
                  Paste a transcript, choose a voice and speed, then listen and download the MP3.
                </p>
              </section>
              {auth === "guest" && guest && (
                <GuestBanner
                  quota={guest.quota}
                  imports={guestImports}
                  onSignIn={logout}
                  leaving={loggingOut}
                />
              )}
              <DubbingForm
                // A new identity starts from its own draft.
                key={draftOwner ?? "session"}
                voices={meta.voices}
                languages={languages.options}
                defaultLanguage={languages.defaultId}
                disclosure={azureDisclosureShort(meta.providers)}
                // Guests import with their own quota, offered only when the server reports it.
                youtubeImport={
                  meta.youtube_import?.enabled === true &&
                  (auth === "authenticated" || guestImports !== null)
                }
                onJobCreated={bound.jobCreated}
                onSessionExpired={bound.sessionExpired}
                initialDraft={draftOwner ? drafts.draftFor(draftOwner) : undefined}
                onDraftChange={draftOwner ? rememberDraft : undefined}
                guest={
                  auth === "guest" && guest
                    ? {
                        maxWords: guest.quota.max_words,
                        maxOutputSeconds: guest.quota.max_output_seconds,
                        onQuotaExhausted: bound.guestChanged,
                        onSignIn: logout,
                        imports: guestImports,
                        windowSeconds: guest.quota.ip_window_seconds,
                        onImportFinished: bound.guestChanged,
                      }
                    : undefined
                }
              />
              {jobId && (
                <JobPanel
                  key={jobId}
                  jobId={jobId}
                  voices={meta.voices}
                  languages={languages.options}
                  onSessionExpired={bound.sessionExpired}
                  onFinished={auth === "guest" ? bound.guestChanged : undefined}
                />
              )}
            </>
          )}
        </main>

        {meta && (
          <AppFooter
            disclosure={azureDisclosure(meta.providers, languageList)}
            resultTtlSeconds={meta.result_ttl_seconds}
          />
        )}
      </div>
    </div>
  );
}
