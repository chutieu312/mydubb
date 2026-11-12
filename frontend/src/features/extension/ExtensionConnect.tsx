import { useCallback, useEffect, useRef, useState } from "react";

import { authApi } from "../../api/authApi";
import type { AuthUser } from "../../api/authTypes";
import { ApiError, api, setCsrfToken } from "../../api/client";
import {
  extensionApi,
  guestRequested,
  parseAuthorization,
  type ExtensionAuthorization,
} from "../../api/extensionApi";
import { guestApi, guestJobsLeft, type GuestSession } from "../../api/guestApi";
import type { AppMeta } from "../../api/types";
import { authModeOf, extensionGuestOf, passwordResetOf } from "../../lib/authMode";
import { AuthCard } from "../auth/AuthCard";
import { PasswordAuthFlow } from "../auth/PasswordAuthFlow";

// /extension/connect: opened by the MyDubb Chrome extension in a sign-in window
// (chrome.identity.launchWebAuthFlow). The user signs in here with the normal website sign-in,
// never in the extension, then approves. See docs/EXTENSION_AUTH.md.
//
// With `mode=guest` (the panel's "Try as guest", offered only when the server says so) the
// browser's guest session is continued in the extension, or, with none yet, started here once the
// user confirms, under the website's usual guest rules. The server names the guest session from
// this page's guest cookie; the extension never chooses it.

interface GuestLimits {
  jobsPerSession: number;
  maxWords: number;
  maxOutputSeconds: number;
}

type Screen =
  | { name: "loading" }
  | { name: "invalid"; message: string }
  | { name: "sign-in"; passwordReset: boolean }
  // `guestAsked`: the extension asked for a guest, but this browser is signed in to an account.
  | { name: "consent"; user: AuthUser; guestAsked: boolean }
  | { name: "connecting"; user: AuthUser; guestAsked: boolean }
  | { name: "guest-start"; limits: GuestLimits; passwordReset: boolean }
  | { name: "guest-consent"; guest: GuestSession; passwordReset: boolean }
  | { name: "guest-connecting"; passwordReset: boolean }
  | { name: "done" }
  | { name: "cancelled" };

const BAD_REQUEST =
  "This page must be opened from the MyDubb Chrome extension. Close this window and choose Connect in the extension.";
const NO_ACCOUNTS = "Connecting the Chrome extension needs a MyDubb invitation account.";
const NO_GUESTS =
  "Trying MyDubb as a guest in the Chrome extension is not available right now. Close this window; you can still connect a MyDubb account.";
const CANNOT_CHECK = "We could not check your session. Close this window and try again.";
// Refusals whose message the server writes for the user.
const SHOWN_AS_IS = new Set([
  "extension_disabled",
  "extension_guest_disabled",
  "extension_unknown",
  "redirect_uri_mismatch",
  "validation_error",
  "guest_sessions_exhausted",
  "guest_network_unknown",
  "guest_access_disabled",
  "already_signed_in",
]);

const shownError = (err: unknown, fallback: string) =>
  err instanceof ApiError && (err.status === 0 || SHOWN_AS_IS.has(err.code)) ? err.message : fallback;

function limitsOf(meta: AppMeta): GuestLimits {
  const limits = meta.guest_access;
  return {
    jobsPerSession: limits?.jobs_per_session ?? 0,
    maxWords: limits?.max_words ?? 0,
    maxOutputSeconds: limits?.max_output_seconds ?? 0,
  };
}

interface Props {
  search?: string;
  // Goes to the extension's redirect URI (replaceable in tests).
  navigate?: (url: string) => void;
}

const goTo = (url: string) => window.location.replace(url);

export function ExtensionConnect({ search = window.location.search, navigate = goTo }: Props) {
  const [authorization] = useState(() => parseAuthorization(search));
  const [asGuest] = useState(() => guestRequested(search));
  const [screen, setScreen] = useState<Screen>(
    authorization ? { name: "loading" } : { name: "invalid", message: BAD_REQUEST },
  );
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const mounted = useRef(true);
  // One request at a time: a second click before React re-renders does nothing.
  const busy = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // What a browser with no account session shows for a guest request: its guest session to
  // continue, or the offer to start one.
  const guestScreen = useCallback(async (loaded: AppMeta): Promise<Screen> => {
    const passwordReset = passwordResetOf(loaded);
    try {
      const guest = await guestApi.get();
      setCsrfToken(guest.csrf_token);
      return { name: "guest-consent", guest, passwordReset };
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthenticated) {
        return { name: "guest-start", limits: limitsOf(loaded), passwordReset };
      }
      throw err;
    }
  }, []);

  useEffect(() => {
    if (!authorization) return;
    let active = true;
    const load = async (): Promise<Screen> => {
      const loaded = await api.meta();
      if (active) setMeta(loaded);
      if (authModeOf(loaded) !== "cognito") return { name: "invalid", message: NO_ACCOUNTS };
      if (asGuest && !extensionGuestOf(loaded)) return { name: "invalid", message: NO_GUESTS };
      try {
        const session = await authApi.me();
        setCsrfToken(session.csrf_token);
        return { name: "consent", user: session.user, guestAsked: asGuest };
      } catch (err) {
        if (!(err instanceof ApiError && err.isUnauthenticated)) throw err;
      }
      if (asGuest) return guestScreen(loaded);
      return { name: "sign-in", passwordReset: passwordResetOf(loaded) };
    };
    load()
      .then((next) => active && setScreen(next))
      .catch(() => active && setScreen({ name: "invalid", message: CANNOT_CHECK }));
    return () => {
      active = false;
    };
  }, [authorization, asGuest, guestScreen]);

  const finish = useCallback(
    (target: string) => {
      setScreen({ name: "done" });
      // Chrome hands this address to the extension and closes the window.
      navigate(target);
    },
    [navigate],
  );

  const connect = useCallback(
    async (user: AuthUser, guestAsked: boolean) => {
      if (!authorization || busy.current) return;
      busy.current = true;
      setError(null);
      setScreen({ name: "connecting", user, guestAsked });
      try {
        const target = await extensionApi.authorize(authorization);
        if (mounted.current) finish(target);
      } catch (err) {
        if (!mounted.current) return;
        if (err instanceof ApiError && err.isUnauthenticated) {
          setCsrfToken(null);
          setScreen({ name: "sign-in", passwordReset: true });
          return;
        }
        setScreen({ name: "consent", user, guestAsked });
        setError(shownError(err, "Could not connect the extension. Please try again."));
      } finally {
        busy.current = false;
      }
    },
    [authorization, finish],
  );

  // Continue the browser's guest session in the extension, starting one first if `start`.
  const connectGuest = useCallback(
    async (auth: ExtensionAuthorization, start: boolean, passwordReset: boolean) => {
      if (busy.current) return;
      busy.current = true;
      setError(null);
      const back = screen;
      setScreen({ name: "guest-connecting", passwordReset });
      try {
        if (start) {
          // 201 for a new guest session; 200 when this browser already has one (unchanged).
          const started = await guestApi.start();
          setCsrfToken(started.csrf_token);
        }
        const target = await extensionApi.authorizeGuest(auth);
        if (mounted.current) finish(target);
      } catch (err) {
        if (!mounted.current) return;
        if (err instanceof ApiError && err.isUnauthenticated && meta) {
          // The guest session ended meanwhile: offer to start one again.
          setCsrfToken(null);
          setScreen({ name: "guest-start", limits: limitsOf(meta), passwordReset });
          setError("Your guest session has ended. You can start a new one.");
          return;
        }
        setScreen(back);
        setError(shownError(err, "Could not connect the extension. Please try again."));
      } finally {
        busy.current = false;
      }
    },
    [finish, meta, screen],
  );

  const signOut = async () => {
    try {
      await authApi.logout();
    } catch {
      // Already signed out, or the server could not be reached: show the sign-in either way.
    }
    setCsrfToken(null);
    setError(null);
    if (asGuest && meta) {
      try {
        setScreen(await guestScreen(meta));
        return;
      } catch {
        // Fall back to the sign-in below.
      }
    }
    setScreen({ name: "sign-in", passwordReset: true });
  };

  const cancel = () => {
    setScreen({ name: "cancelled" });
    // Chrome may refuse to let the page close its sign-in window.
    window.close();
  };

  const errorLine = error && (
    <p className="callout error" role="alert">
      {error}
    </p>
  );

  return (
    <div className="app">
      <div className="page">
        <main className="main">
          {screen.name === "loading" && <p className="muted">Loading…</p>}
          {screen.name === "invalid" && (
            <p className="callout error" role="alert">
              {screen.message}
            </p>
          )}
          {screen.name === "sign-in" && (
            <PasswordAuthFlow
              notice="Sign in to connect the MyDubb Chrome extension."
              passwordReset={screen.passwordReset}
              onAuthenticated={(user) => setScreen({ name: "consent", user, guestAsked: false })}
            />
          )}
          {(screen.name === "consent" || screen.name === "connecting") && (
            <AuthCard title="Connect the Chrome extension">
              {screen.guestAsked && (
                <p className="callout" role="status">
                  You chose Try as guest in the extension, but this browser is signed in to an
                  account. Connect with this account, or sign out to continue as a guest.
                </p>
              )}
              <p>
                Signed in as <strong>{screen.user.display_name ?? screen.user.email}</strong>
                {screen.user.display_name ? ` (${screen.user.email})` : ""}.
              </p>
              <p className="muted">
                The MyDubb extension in this Chrome profile will be able to create dubbing jobs with
                this account and play their audio, for up to 12 hours or until you disconnect it
                there. It never sees your password.
              </p>
              {errorLine}
              <div className="stack">
                <button
                  type="button"
                  className="button primary wide"
                  disabled={screen.name === "connecting"}
                  onClick={() => void connect(screen.user, screen.guestAsked)}
                >
                  {screen.name === "connecting" ? "Connecting…" : "Connect extension"}
                </button>
                <button type="button" className="button ghost" onClick={cancel}>
                  Cancel
                </button>
                <button type="button" className="link-button" onClick={() => void signOut()}>
                  {screen.guestAsked ? "Sign out and continue as a guest" : "Not you? Sign out"}
                </button>
              </div>
            </AuthCard>
          )}
          {authorization && screen.name === "guest-start" && (
            <AuthCard title="Try MyDubb as a guest">
              <p>
                No account needed: up to {screen.limits.jobsPerSession} audio jobs of up to{" "}
                {screen.limits.maxWords.toLocaleString("en-US")} words and{" "}
                {Math.round(screen.limits.maxOutputSeconds / 60)} minutes of audio each.
              </p>
              <p className="muted">
                This starts a guest session in this browser. The extension and mydubb.com in this
                Chrome profile share it, so jobs made in either count towards the same limits. It
                ends after 24 hours, when you leave guest mode on mydubb.com, or when you sign in.
              </p>
              {errorLine}
              <div className="stack">
                <button
                  type="button"
                  className="button primary wide"
                  onClick={() => void connectGuest(authorization, true, screen.passwordReset)}
                >
                  Start guest session
                </button>
                <button type="button" className="button ghost" onClick={cancel}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setScreen({ name: "sign-in", passwordReset: screen.passwordReset })}
                >
                  Have an account? Sign in instead
                </button>
              </div>
            </AuthCard>
          )}
          {authorization && screen.name === "guest-consent" && (
            <AuthCard title="Continue as a guest in the extension">
              <p>
                You are using MyDubb as a guest in this browser:{" "}
                <strong>
                  {guestJobsLeft(screen.guest.quota)} of {screen.guest.quota.session_limit} audio
                  jobs left
                </strong>
                .
              </p>
              <p className="muted">
                The extension continues this same guest session, so jobs you make there count
                towards the same limits. No new guest session is started.
              </p>
              {errorLine}
              <div className="stack">
                <button
                  type="button"
                  className="button primary wide"
                  onClick={() => void connectGuest(authorization, false, screen.passwordReset)}
                >
                  Continue in the extension
                </button>
                <button type="button" className="button ghost" onClick={cancel}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setScreen({ name: "sign-in", passwordReset: screen.passwordReset })}
                >
                  Have an account? Sign in instead
                </button>
              </div>
            </AuthCard>
          )}
          {screen.name === "guest-connecting" && <p className="muted">Connecting…</p>}
          {screen.name === "cancelled" && (
            <p className="callout" role="status">
              The extension was not connected. You can close this window.
            </p>
          )}
          {screen.name === "done" && (
            <p className="callout" role="status">
              Connected. You can close this window.
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
