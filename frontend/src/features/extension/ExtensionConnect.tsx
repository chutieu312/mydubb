import { useCallback, useEffect, useRef, useState } from "react";

import { authApi } from "../../api/authApi";
import type { AuthUser } from "../../api/authTypes";
import { ApiError, api, setCsrfToken } from "../../api/client";
import { extensionApi, parseAuthorization } from "../../api/extensionApi";
import { authModeOf, passwordResetOf } from "../../lib/authMode";
import { AuthCard } from "../auth/AuthCard";
import { PasswordAuthFlow } from "../auth/PasswordAuthFlow";

// /extension/connect: opened by the MyDubb Chrome extension in a sign-in window
// (chrome.identity.launchWebAuthFlow). The user signs in here with the normal website sign-in,
// never in the extension, then approves. Only invited accounts can connect; there is no guest.
// See docs/EXTENSION_AUTH.md.

type Screen =
  | { name: "loading" }
  | { name: "invalid"; message: string }
  | { name: "sign-in"; passwordReset: boolean }
  | { name: "consent"; user: AuthUser }
  | { name: "connecting"; user: AuthUser }
  | { name: "done" }
  | { name: "cancelled" };

const BAD_REQUEST =
  "This page must be opened from the MyDubb Chrome extension. Close this window and choose Connect in the extension.";
const NO_ACCOUNTS = "Connecting the Chrome extension needs a MyDubb invitation account.";
const CANNOT_CHECK = "We could not check your session. Close this window and try again.";
// Refusals whose message the server writes for the user.
const SHOWN_AS_IS = new Set([
  "extension_disabled",
  "extension_unknown",
  "redirect_uri_mismatch",
  "validation_error",
]);

interface Props {
  search?: string;
  // Goes to the extension's redirect URI (replaceable in tests).
  navigate?: (url: string) => void;
}

const goTo = (url: string) => window.location.replace(url);

export function ExtensionConnect({ search = window.location.search, navigate = goTo }: Props) {
  const [authorization] = useState(() => parseAuthorization(search));
  const [screen, setScreen] = useState<Screen>(
    authorization ? { name: "loading" } : { name: "invalid", message: BAD_REQUEST },
  );
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!authorization) return;
    let active = true;
    const load = async () => {
      const meta = await api.meta();
      if (authModeOf(meta) !== "cognito") return { name: "invalid", message: NO_ACCOUNTS } as const;
      try {
        const session = await authApi.me();
        setCsrfToken(session.csrf_token);
        return { name: "consent", user: session.user } as const;
      } catch (err) {
        if (err instanceof ApiError && err.isUnauthenticated) {
          return {
            name: "sign-in",
            passwordReset: passwordResetOf(meta),
          } as const;
        }
        throw err;
      }
    };
    load()
      .then((next) => active && setScreen(next))
      .catch(() => active && setScreen({ name: "invalid", message: CANNOT_CHECK }));
    return () => {
      active = false;
    };
  }, [authorization]);

  const connect = useCallback(
    async (user: AuthUser) => {
      if (!authorization) return;
      setError(null);
      setScreen({ name: "connecting", user });
      try {
        const target = await extensionApi.authorize(authorization);
        if (!mounted.current) return;
        setScreen({ name: "done" });
        // Chrome hands this address to the extension and closes the window.
        navigate(target);
      } catch (err) {
        if (!mounted.current) return;
        if (err instanceof ApiError && err.isUnauthenticated) {
          setCsrfToken(null);
          setScreen({ name: "sign-in", passwordReset: true });
          return;
        }
        setScreen({ name: "consent", user });
        setError(
          err instanceof ApiError && (err.status === 0 || SHOWN_AS_IS.has(err.code))
            ? err.message
            : "Could not connect the extension. Please try again.",
        );
      }
    },
    [authorization, navigate],
  );

  const signOut = async () => {
    try {
      await authApi.logout();
    } catch {
      // Already signed out, or the server could not be reached: show the sign-in either way.
    }
    setCsrfToken(null);
    setError(null);
    setScreen({ name: "sign-in", passwordReset: true });
  };

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
              onAuthenticated={(user) => setScreen({ name: "consent", user })}
            />
          )}
          {(screen.name === "consent" || screen.name === "connecting") && (
            <AuthCard title="Connect the Chrome extension">
              <p>
                Signed in as <strong>{screen.user.display_name ?? screen.user.email}</strong>
                {screen.user.display_name ? ` (${screen.user.email})` : ""}.
              </p>
              <p className="muted">
                The MyDubb extension in this Chrome profile will be able to create dubbing jobs with
                this account and play their audio, for up to 12 hours or until you disconnect it
                there. It never sees your password.
              </p>
              {error && (
                <p className="callout error" role="alert">
                  {error}
                </p>
              )}
              <div className="stack">
                <button
                  type="button"
                  className="button primary wide"
                  disabled={screen.name === "connecting"}
                  onClick={() => void connect(screen.user)}
                >
                  {screen.name === "connecting" ? "Connecting…" : "Connect extension"}
                </button>
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => {
                    setScreen({ name: "cancelled" });
                    // Chrome may refuse to let the page close its sign-in window.
                    window.close();
                  }}
                >
                  Cancel
                </button>
                <button type="button" className="link-button" onClick={() => void signOut()}>
                  Not you? Sign out
                </button>
              </div>
            </AuthCard>
          )}
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
