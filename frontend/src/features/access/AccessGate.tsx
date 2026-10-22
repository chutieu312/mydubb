import { useState, type FormEvent } from "react";

import { ApiError, api, setCsrfToken } from "../../api/client";

interface Props {
  onAuthenticated: () => void;
}

export function AccessGate({ onAuthenticated }: Props) {
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
    <section className="card narrow" aria-labelledby="access-title">
      <h2 id="access-title">Private Beta Access</h2>
      <form onSubmit={submit} className="stack">
        <label htmlFor="access-code">Access Code</label>
        <input
          id="access-code"
          type="password"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting || code.length === 0}>
          {submitting ? "Checking…" : "Enter"}
        </button>
      </form>
    </section>
  );
}
