import type { Theme } from "../lib/theme";

interface Props {
  theme: Theme;
  onToggle: () => void;
}

export function ThemeToggle({ theme, onToggle }: Props) {
  const toDark = theme === "light";
  return (
    <button
      type="button"
      className="button ghost pill"
      onClick={onToggle}
      aria-label={toDark ? "Switch to dark mode" : "Switch to light mode"}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        {toDark ? (
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="currentColor" />
        ) : (
          <>
            <circle cx="12" cy="12" r="4.2" fill="currentColor" />
            <path
              d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M5.3 18.7 7 17M17 7l1.7-1.7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
      {toDark ? "Dark mode" : "Light mode"}
    </button>
  );
}
