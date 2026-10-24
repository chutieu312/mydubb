import { useState, type FormEvent } from "react";

import { ApiError, api, setCsrfToken } from "../../api/client";

interface Props {
  // Shown when a session ended (expired, or the server no longer recognises it).
  notice?: string | null;
  onAuthenticated: () => void;
}

export function AccessGate({ notice, onAuthenticated }: Props) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const session = await api.login(code);
      setCsrfToken(session.csrf_token);
      setCode("");
      onAuthenticated();
    } catch (err) {
      if (err instanceof ApiError && err.code === "too_many_attempts" && err.retryAfterSeconds) {
        const minutes = Math.ceil(err.retryAfterSeconds / 60);
        setError(`${err.message} (about ${minutes} min)`);
      } else {
        setError(err instanceof ApiError ? err.message : "Login failed.");
      }
    } finally {
      setSubmitting(false);
    }
  };

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
        <h2>Welcome to MyDubb</h2>
        <p className="muted">Enter the Access Code you were given to open your studio.</p>
        {notice && (
          <p className="callout warning" role="alert">
            {notice}
          </p>
        )}
        <form onSubmit={submit} className="stack">
          <div className="field">
            <label htmlFor="access-code">Access Code</label>
            <input
              id="access-code"
              type="password"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="button primary wide"
            disabled={submitting || code.length === 0}
          >
            {submitting ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </section>
  );
}
