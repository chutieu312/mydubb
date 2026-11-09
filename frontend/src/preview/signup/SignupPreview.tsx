import { useRef, useState, type FormEvent } from "react";

import { AppFooter } from "../../components/AppFooter";
import { AppHeader } from "../../components/AppHeader";
import { AuthCard } from "../../features/auth/AuthCard";
import { FormError, PasswordField, TextField } from "../../features/auth/fields";
import { useTheme } from "../../lib/useTheme";
import { CasesPanel } from "./CasesPanel";
import { CreateAccountForm } from "./CreateAccountForm";
import { DemoStudio } from "./DemoStudio";
import { createMockSignup, type MockSignup } from "./mockSignup";
import { VerifyCodeForm } from "./VerifyCodeForm";
import "./preview.css";

// Everything lives in this component's memory. The page makes no request and writes nothing but
// the appearance (light/dark) that the header's toggle already saves for the whole site.
type Screen = "sign-in" | "create" | "verify" | "verified" | "studio";

const SIGN_IN_OFF =
  "Sign in is switched off in this preview. Use Create account to try the new flow.";

/** Today's Sign in card (SignInForm) with Create account beside it. */
function PreviewSignIn({ onCreateAccount }: { onCreateAccount: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setMessage(SIGN_IN_OFF);
  };

  return (
    <>
      <form onSubmit={submit} className="stack">
        <TextField
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="username"
          value={email}
          onChange={setEmail}
        />
        <PasswordField
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
        />
        <FormError message={message} />
        <button
          type="submit"
          className="button primary wide"
          disabled={email.trim() === "" || password === ""}
        >
          Sign in
        </button>
      </form>
      <div className="signup-entry">
        <p className="muted">New to MyDubb?</p>
        <button type="button" className="button ghost wide" onClick={onCreateAccount}>
          Create account
        </button>
        <p className="small muted">
          Free plan: 20 Generates and 5 YouTube imports per day. Limits reset at 00:00 UTC.
        </p>
      </div>
    </>
  );
}

// `makeService` is for tests: they hand in a mock whose requests they finish themselves.
export default function SignupPreview({
  makeService = () => createMockSignup(),
}: {
  makeService?: () => MockSignup;
}) {
  const [theme, toggleTheme] = useTheme();
  const [service, setService] = useState(makeService);
  // The service of the attempt on screen. Start over replaces it, so an answer from an earlier
  // service (a request still pending when Start over was pressed) can be told apart and ignored.
  const liveService = useRef(service);
  const [screen, setScreen] = useState<Screen>("sign-in");
  const [email, setEmail] = useState("");
  // False for the first screen only; later screens take focus on their title.
  const [navigated, setNavigated] = useState(false);

  const go = (next: Screen) => {
    setScreen(next);
    setNavigated(true);
  };
  const startOver = () => {
    service.reset();
    const next = makeService();
    liveService.current = next;
    setService(next);
    setEmail("");
    go("sign-in");
  };
  // True while `mine` (the service a form was rendered with) is still the attempt on screen.
  const stillCurrent = (mine: MockSignup) => liveService.current === mine;

  const common = { focusTitle: navigated };

  return (
    <div className="app">
      <AppHeader
        theme={theme}
        onToggleTheme={toggleTheme}
        signedIn={screen === "studio"}
        user={screen === "studio" ? { email: email || "demo@example.com", display_name: null } : null}
        loggingOut={false}
        onLogout={startOver}
      />
      <div className="page">
        <div className="preview-ribbon" role="note">
          <p>
            <strong>Prototype preview.</strong> Simulated data: no account is created, no email or
            CAPTCHA service is called, and nothing leaves this page.
          </p>
          <button type="button" className="link-button" onClick={startOver}>
            Start over
          </button>
        </div>
        <main className="main">
          {screen === "sign-in" && (
            <AuthCard title="Sign in to MyDubb" {...common}>
              <PreviewSignIn onCreateAccount={() => go("create")} />
            </AuthCard>
          )}
          {screen === "create" && (
            <AuthCard
              title="Create your account"
              intro="Create a free account to turn English transcripts into audio in your language."
              {...common}
            >
              <CreateAccountForm
                service={service}
                initialEmail={email}
                onCreated={(address) => {
                  if (!stillCurrent(service)) return;
                  setEmail(address);
                  go("verify");
                }}
                onBackToSignIn={() => go("sign-in")}
              />
            </AuthCard>
          )}
          {screen === "verify" && (
            <AuthCard
              title="Verify your email"
              intro={
                <>
                  We sent a verification code to <strong>{email}</strong>. Enter it below to finish
                  creating your account.
                </>
              }
              {...common}
            >
              <VerifyCodeForm
                service={service}
                email={email}
                onVerified={() => stillCurrent(service) && go("verified")}
                onChangeEmail={() => go("create")}
                onBackToSignIn={() => go("sign-in")}
              />
            </AuthCard>
          )}
          {screen === "verified" && (
            <AuthCard
              title="Email verified"
              intro={`Your account for ${email} is ready. Next you would open your Studio.`}
              {...common}
            >
              <p className="callout" role="status">
                Verified. In this preview no account or session exists.
              </p>
              <button type="button" className="button primary wide" onClick={() => go("studio")}>
                Open Studio (demo)
              </button>
            </AuthCard>
          )}
          {screen === "studio" && <DemoStudio />}
          {screen !== "studio" && <CasesPanel />}
        </main>
        <AppFooter disclosure={null} resultTtlSeconds={3600} />
      </div>
    </div>
  );
}
