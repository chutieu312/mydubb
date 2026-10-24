import { useEffect, useRef, type ReactNode } from "react";

export interface AuthNotice {
  text: string;
  tone: "info" | "warning";
}

interface Props {
  title: string;
  intro?: ReactNode;
  notice?: AuthNotice | null;
  // Move focus to the title when the screen appears after an in-page step, so keyboard and
  // screen-reader users land on the new screen. Off for the first screen of a page load.
  focusTitle?: boolean;
  children: ReactNode;
}

/** The Studio sign-in layout (same card as the Access Code screen) around one auth screen. */
export function AuthCard({ title, intro, notice, focusTitle = false, children }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
  }, [focusTitle]);

  return (
    <section className="gate" aria-labelledby="gate-title">
      <div className="gate-story">
        <p className="eyebrow">Less reading. More understanding.</p>
        <h1 id="gate-title">A new language. The same ideas.</h1>
        <p className="muted">
          Natural Vietnamese voices. Clear English terms. Audio that fits your pace.
        </p>
      </div>
      <div className="gate-form">
        <h2 ref={titleRef} tabIndex={-1}>
          {title}
        </h2>
        {intro && <div className="muted">{intro}</div>}
        {notice && (
          <p
            className={notice.tone === "warning" ? "callout warning" : "callout"}
            role={notice.tone === "warning" ? "alert" : "status"}
          >
            {notice.text}
          </p>
        )}
        {children}
      </div>
    </section>
  );
}
