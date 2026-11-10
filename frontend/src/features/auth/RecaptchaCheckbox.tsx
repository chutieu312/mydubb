import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { loadRecaptcha, type RecaptchaApi } from "../../lib/recaptcha";

interface Props {
  siteKey: string;
  // The token of a ticked box, or null when there is none (not ticked yet, expired, reset).
  onToken: (token: string | null) => void;
  // Bumped by the form after every attempt: a token is single-use, so the box starts over.
  resetSignal: number;
  error?: string | null;
}

// The normal widget is 304 px wide; under that the compact one keeps the card from overflowing.
const NORMAL_WIDTH = 304;

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

const currentTheme = () =>
  document.documentElement.dataset.theme === "dark" ? ("dark" as const) : ("light" as const);

/**
 * Google's "I'm not a robot" box. The widget itself is Google's iframe (its own keyboard and
 * screen-reader support); MyDubb adds a label, loading and failure states and the message beside it.
 */
export function RecaptchaCheckbox({ siteKey, onToken, resetSignal, error }: Props) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  // A new widget for each theme (Google draws the theme once); the box then starts unticked.
  return (
    <RecaptchaWidget
      key={theme}
      theme={theme}
      siteKey={siteKey}
      onToken={onToken}
      resetSignal={resetSignal}
      error={error}
    />
  );
}

type Load = "loading" | "ready" | "failed";

function RecaptchaWidget({
  siteKey,
  onToken,
  resetSignal,
  error,
  theme,
}: Props & { theme: "light" | "dark" }) {
  const labelId = useId();
  const errorId = `${labelId}-error`;
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: RecaptchaApi; id: number } | null>(null);
  const [load, setLoad] = useState<Load>("loading");
  const [attempt, setAttempt] = useState(0);
  const [expired, setExpired] = useState(false);
  // The latest callback, so Google's callbacks never call a stale one.
  const tokenSink = useRef(onToken);
  useEffect(() => {
    tokenSink.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let active = true;
    const container = box.current;
    loadRecaptcha()
      .then((api) => {
        if (!active || !container) return;
        const target = document.createElement("div");
        container.replaceChildren(target);
        const id = api.render(target, {
          sitekey: siteKey,
          theme,
          size: container.clientWidth > 0 && container.clientWidth < NORMAL_WIDTH ? "compact" : "normal",
          callback: (token) => {
            setExpired(false);
            tokenSink.current(token);
          },
          "expired-callback": () => {
            setExpired(true);
            tokenSink.current(null);
          },
          "error-callback": () => {
            // Usually the network; Google leaves telling the user to us.
            tokenSink.current(null);
            setLoad("failed");
          },
        });
        widget.current = { api, id };
        setLoad("ready");
      })
      .catch(() => {
        if (active) setLoad("failed");
      });
    return () => {
      active = false;
      widget.current = null;
      tokenSink.current(null);
    };
  }, [siteKey, theme, attempt]);

  useEffect(() => {
    if (resetSignal === 0 || !widget.current) return;
    widget.current.api.reset(widget.current.id);
    tokenSink.current(null);
  }, [resetSignal]);

  const retry = () => {
    setLoad("loading");
    setAttempt((n) => n + 1);
  };

  return (
    <div className="field" role="group" aria-labelledby={labelId} aria-describedby={error ? errorId : undefined}>
      <span id={labelId} className="field-label">
        Robot check
      </span>
      <div ref={box} className={error ? "recaptcha-box invalid" : "recaptcha-box"} />
      {load === "loading" && <p className="small muted">Loading the robot check…</p>}
      {load === "failed" && (
        <div className="stack">
          <p className="error" role="alert">
            The robot check could not load. Check your connection, then try again.
          </p>
          <button type="button" className="button ghost" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {expired && !error && (
        <p className="small muted" role="status">
          The check expired. Tick the box again.
        </p>
      )}
      {error && (
        <p id={errorId} className="error" role="alert">
          {error}
        </p>
      )}
      <p className="small muted recaptcha-note">
        This site is protected by reCAPTCHA and the Google{" "}
        <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">
          Privacy Policy
        </a>{" "}
        and{" "}
        <a href="https://policies.google.com/terms" target="_blank" rel="noreferrer">
          Terms of Service
        </a>{" "}
        apply.
      </p>
    </div>
  );
}
