interface Props {
  // Full statement of which text goes to which outside service; null when nothing leaves the server.
  disclosure: string | null;
  resultTtlSeconds: number | null;
}

/** "1 hour", "30 minutes": how long results are kept, in words. */
function formatTtl(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function AppFooter({ disclosure, resultTtlSeconds }: Props) {
  return (
    <footer className="footer">
      <p className="muted small">English terms are kept in English.</p>
      <details className="disclosure plain">
        <summary>Privacy</summary>
        <div className="disclosure-body small">
          {disclosure && <p>{disclosure}</p>}
          <p>
            The translation and audio are kept temporarily
            {resultTtlSeconds ? ` (about ${formatTtl(resultTtlSeconds)})` : ""} so you can listen
            and download them. Download a copy if you want to keep it.
          </p>
        </div>
      </details>
    </footer>
  );
}
