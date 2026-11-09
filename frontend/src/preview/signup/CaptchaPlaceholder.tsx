import { useId } from "react";

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string | null;
}

/**
 * A stand-in for the Google reCAPTCHA checkbox. It loads no script and calls no service: ticking
 * it only sets local state. The note under it says so, for the people reviewing the preview.
 */
export function CaptchaPlaceholder({ checked, onChange, error }: Props) {
  const id = useId();
  const noteId = `${id}-note`;
  const errorId = `${id}-error`;
  return (
    <div className="field">
      <div className={error ? "captcha-box invalid" : "captcha-box"}>
        <label className="captcha-label" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${errorId} ${noteId}` : noteId}
          />
          I&apos;m not a robot
        </label>
        <span className="captcha-tag" aria-hidden="true">
          Simulated
        </span>
      </div>
      {error && (
        <p id={errorId} className="error">
          {error}
        </p>
      )}
      <p id={noteId} className="small muted">
        Simulated checkbox. No Google reCAPTCHA is loaded or called in this preview.
      </p>
    </div>
  );
}
