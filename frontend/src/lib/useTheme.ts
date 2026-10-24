import { useCallback, useEffect, useState } from "react";

import { applyTheme, readStoredTheme, storeTheme, type Theme } from "./theme";

/** Current theme and a toggle that applies and saves it. Changing it touches no other state. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => applyTheme(theme), [theme]);

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    storeTheme(next);
    setTheme(next);
  }, [theme]);

  return [theme, toggle];
}
