import {
  BUSY_EMAIL,
  DEMO_CODE,
  EXPIRED_CODE,
  RESEND_WAIT_SECONDS,
  UNAVAILABLE_CODE,
} from "./mockSignup";

interface Row {
  name: string;
  how: string;
  result: string;
}

// Kept next to the mock so the page and the behaviour cannot drift apart (a test checks both).
const CREATE_ROWS: Row[] = [
  {
    name: "Empty form",
    how: "Press Create account with nothing filled in.",
    result: "A message beside Email, Password and the checkbox. Focus moves to Email.",
  },
  {
    name: "Wrong email",
    how: "Type ada@ and press Create account.",
    result: "A message beside Email.",
  },
  {
    name: "Short password",
    how: "Type a password shorter than 8 characters.",
    result: "A message beside Password (a rule of this preview, not the real one).",
  },
  {
    name: "Checkbox not ticked",
    how: "Fill in a valid email and password, leave the box unticked.",
    result: "A message beside the checkbox.",
  },
  {
    name: "Temporary service error",
    how: `Use ${BUSY_EMAIL} with any password of 8+ characters and tick the box.`,
    result: "The first try fails with a retry message and keeps your input. The second try works.",
  },
  {
    name: "Success",
    how: "Any other valid email, a password of 8+ characters, box ticked.",
    result: "The Verify email screen.",
  },
];

const VERIFY_ROWS: Row[] = [
  { name: "Success", how: `Enter ${DEMO_CODE}.`, result: "Email verified, then the demo Studio." },
  {
    name: "Wrong code",
    how: "Enter any other 6 digits, such as 654321.",
    result: "A message beside the code box.",
  },
  {
    name: "Expired code",
    how: `Enter ${EXPIRED_CODE}.`,
    result: "An expired message beside the code box.",
  },
  {
    name: "Temporary service error",
    how: `Enter ${UNAVAILABLE_CODE}.`,
    result: "A retry message under the code box. Try again with another code.",
  },
  {
    name: "Not a code",
    how: "Leave it empty, or type letters.",
    result: "A message beside the code box.",
  },
  {
    name: "Resend code",
    how: "Press Resend code.",
    result: `A confirmation, the box is cleared, and the button waits ${RESEND_WAIT_SECONDS} s.`,
  },
  {
    name: "Go back",
    how: "Use a different email, or Back to sign in.",
    result: "Create account with your email filled in, or the Sign in screen.",
  },
];

function Group({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section className="stack" aria-label={title}>
      <h3>{title}</h3>
      <ul className="cases-list">
        {rows.map((row) => (
          <li key={row.name}>
            <strong>{row.name}.</strong> {row.how} <span className="muted">{row.result}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The demo data, on the page itself, so the preview can be tried without any other document. */
export function CasesPanel() {
  return (
    <details className="cases" open>
      <summary>Try these cases</summary>
      <div className="cases-body">
        <Group title="Create account" rows={CREATE_ROWS} />
        <Group title="Verify email" rows={VERIFY_ROWS} />
        <p className="small muted">
          Studio: press Generate audio in the demo Studio to see that nothing is sent.
        </p>
      </div>
    </details>
  );
}
