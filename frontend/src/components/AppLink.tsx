import type { AnchorHTMLAttributes, MouseEvent } from "react";

import { navigateTo } from "../lib/appRoute";

/** A real link to a page of this app: a plain click stays in the page, so the page's memory (the
 * Studio draft) survives; opening it in a new tab or window works as for any link. */
export function AppLink({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    const plainClick =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (!plainClick || event.defaultPrevented) return;
    event.preventDefault();
    navigateTo(href);
    document.documentElement.scrollTop = 0;
  };
  return <a href={href} onClick={follow} {...rest} />;
}
