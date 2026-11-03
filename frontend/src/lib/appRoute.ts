import { useSyncExternalStore } from "react";

// The website has one more page than the Studio, so no router: the address is read from
// `window.location`, changed with the History API, and Back/Forward arrive as `popstate`.

export const USAGE_PATH = "/admin/usage";

export type AppRoute = "studio" | "usage";

export const routeOf = (pathname: string): AppRoute =>
  pathname.replace(/\/+$/, "") === USAGE_PATH ? "usage" : "studio";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

const notify = () => listeners.forEach((listener) => listener());

/** A new entry in the browser's history. */
export function navigateTo(url: string): void {
  window.history.pushState(null, "", url);
  notify();
}

/** Changes the current entry (no new step for Back). */
export function replaceUrl(url: string): void {
  window.history.replaceState(null, "", url);
  notify();
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function useSearch(): string {
  return useSyncExternalStore(subscribe, () => window.location.search);
}
