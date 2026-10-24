import type { Theme } from "../lib/theme";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  theme: Theme;
  onToggleTheme: () => void;
  signedIn: boolean;
  loggingOut: boolean;
  onLogout: () => void;
}

export function AppHeader({ theme, onToggleTheme, signedIn, loggingOut, onLogout }: Props) {
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
              <span className="signed-in muted">Signed in</span>
              <button type="button" className="button ghost" onClick={onLogout} disabled={loggingOut}>
                {loggingOut ? "Logging out…" : "Log out"}
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
