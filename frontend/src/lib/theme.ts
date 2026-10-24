// Appearance preference. Light is the default and the OS setting is deliberately ignored.
// localStorage holds this one value and nothing else (never tokens or the Access Code).
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "mydubb-theme";

/** The saved preference, or light when none was saved or storage is unavailable. */
export function readStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    // Storage can be blocked (private mode, policy); the choice then lasts for this visit only.
    return "light";
  }
}

export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Not saving is acceptable; the theme still applies to the open page.
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
