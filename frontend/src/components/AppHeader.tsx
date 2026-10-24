import type { AuthUser } from "../api/authTypes";
import type { Theme } from "../lib/theme";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  theme: Theme;
  onToggleTheme: () => void;
  signedIn: boolean;
  // Known only with email + password sign-in; the Access Code session has no user.
  user?: Pick<AuthUser, "email" | "display_name"> | null;
  loggingOut: boolean;
  onLogout: () => void;
}

export function AppHeader({ theme, onToggleTheme, signedIn, user, loggingOut, onLogout }: Props) {
  const account = user ? user.display_name?.trim() || user.email : null;
  return (
    <header className="header">
      <div className="header-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <b />
            <b />
            <b />
          </span>
          MyDubb
        </div>
        <div className="header-actions">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          {signedIn && (
            <>
              {account ? (
                <span className="signed-in muted account" title={user?.email}>
                  <span className="sr-only">Signed in as </span>
                  {account}
                </span>
              ) : (
                <span className="signed-in muted">Signed in</span>
              )}
              <button type="button" className="button ghost" onClick={onLogout} disabled={loggingOut}>
                {account
                  ? loggingOut
                    ? "Signing out…"
                    : "Sign out"
                  : loggingOut
                    ? "Logging out…"
                    : "Log out"}
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
