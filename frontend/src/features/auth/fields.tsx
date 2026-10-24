import { useId, useState, type HTMLInputAutoCompleteAttribute } from "react";

interface BaseProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: HTMLInputAutoCompleteAttribute;
  error?: string | null;
  disabled?: boolean;
  required?: boolean;
  // Extra ids (e.g. a requirements list) that describe the input.
  describedBy?: string;
}

function describedByIds(...ids: (string | false | undefined)[]): string | undefined {
  const present = ids.filter(Boolean).join(" ");
  return present || undefined;
}

export function TextField({
  label,
  value,
  onChange,
  autoComplete,
  error,
  disabled,
  required = true,
  describedBy,
  type = "text",
  inputMode,
}: BaseProps & { type?: "text" | "email"; inputMode?: "numeric" | "email" }) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedByIds(describedBy, error ? errorId : undefined)}
      />
      {error && (
        <p id={errorId} className="error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Password input with a Show/Hide button. The value lives only in the parent's state. */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  error,
  disabled,
  describedBy,
}: BaseProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-action">
        <input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={describedByIds(describedBy, error ? errorId : undefined)}
        />
        <button
          type="button"
          className="input-action-button"
          onClick={() => setVisible((shown) => !shown)}
          aria-pressed={visible}
          aria-label={visible ? "Hide password" : "Show password"}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {error && (
        <p id={errorId} className="error">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p className="error" role="alert">
      {message}
    </p>
  );
}
