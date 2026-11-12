import { useEffect, useRef, useState } from "react";

import { authApi } from "../../api/authApi";
import type { AuthStep, AuthUser } from "../../api/authTypes";
import { setCsrfToken } from "../../api/client";
import type { SignupOffer } from "../../lib/authMode";
import { AuthCard, type AuthNotice } from "./AuthCard";
import { CreateAccountForm } from "./CreateAccountForm";
import {
  endedStepNotice,
  toCodedFailure,
  toFailure,
  toResetFailure,
  type Outcome,
} from "./errors";
import { ForgotPasswordForm, ResetPasswordForm } from "./ForgotPasswordForms";
import { NewPasswordForm } from "./NewPasswordForm";
import { SignInForm, type GuestOffer } from "./SignInForm";
import { VerifyEmailForm } from "./VerifyEmailForm";
import { VerifySignupForm } from "./VerifySignupForm";

// Everything here lives in component state (memory). The challenge id is an opaque server
// identifier, still never written to storage or the URL, and never logged. Passwords are held by
// the form that typed them and are gone when that form unmounts.
type Screen =
  | { name: "sign-in" }
  | { name: "new-password"; challengeId: string }
  | { name: "verify-email"; challengeId: string }
  | { name: "forgot-password" }
  | { name: "reset-password" }
  // Public sign-up. The email of verify-signup is null when the user typed none yet.
  | { name: "create-account" }
  | { name: "verify-signup"; email: string | null };

interface Props {
  // Shown on the first sign-in screen, e.g. after the session expired.
  notice?: string | null;
  // From GET /api/meta (auth.password_reset): without it there is no Forgot password.
  passwordReset?: boolean;
  // From GET /api/meta (guest_access): "Try as guest" under the sign-in form.
  guest?: GuestOffer;
  // From GET /api/meta (signup): "Create account" next to Sign in. Absent: invitation only.
  signup?: SignupOffer | null;
  // "create-account": the page was opened at /signup (the extension's Create a MyDubb account).
  // Only when sign-up is offered; otherwise the flow starts at Sign in as always.
  initialScreen?: "sign-in" | "create-account";
  // "MyDubb for Chrome" under the sign-in form (the website's own sign-in page only).
  chromeExtension?: { guest: boolean };
  onAuthenticated: (user: AuthUser) => void;
}

const warning = (text: string): AuthNotice => ({ text, tone: "warning" });
const info = (text: string): AuthNotice => ({ text, tone: "info" });

export function PasswordAuthFlow({
  notice,
  passwordReset = true,
  guest,
  signup,
  initialScreen = "sign-in",
  chromeExtension,
  onAuthenticated,
}: Props) {
  const [screen, setScreen] = useState<Screen>(() =>
    initialScreen === "create-account" && signup ? { name: "create-account" } : { name: "sign-in" },
  );
  const [screenNotice, setScreenNotice] = useState<AuthNotice | null>(
    notice ? warning(notice) : null,
  );
  // False only for the first screen of a page load; later screens take focus.
  const [navigated, setNavigated] = useState(false);
  const [email, setEmail] = useState("");

  // A response may only change what is on screen if the user is still where the request was
  // made: every screen change bumps `epoch`, and an unmounted flow ignores everything.
  const epoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const go = (next: Screen, nextNotice: AuthNotice | null = null) => {
    epoch.current += 1;
    setScreen(next);
    setScreenNotice(nextNotice);
    setNavigated(true);
  };
  const backToSignIn = (nextNotice: AuthNotice | null = null) =>
    go({ name: "sign-in" }, nextNotice);

  const proceed = (step: AuthStep) => {
    switch (step.status) {
      case "authenticated":
        setCsrfToken(step.csrf_token);
        onAuthenticated(step.user);
        break;
      case "new_password_required":
        go({ name: "new-password", challengeId: step.challenge_id });
        break;
      case "email_verification_required":
        go({ name: "verify-email", challengeId: step.challenge_id });
        break;
    }
  };

  // Runs one request. Null means "nothing to show" (success, or a stale answer that is ignored);
  // a Failure is what the form displays. No request is ever repeated automatically.
  async function attempt<T>(
    request: () => Promise<T>,
    onSuccess: (result: T) => void,
    onError: (err: unknown) => Outcome,
  ): Promise<Outcome> {
    const started = epoch.current;
    const current = () => mounted.current && epoch.current === started;
    try {
      const result = await request();
      if (current()) onSuccess(result);
      return null;
    } catch (err) {
      return current() ? onError(err) : null;
    }
  }

  // A pending step that cannot continue sends the user back to sign in with an explanation;
  // any other failure is shown by the step itself.
  const stepError = (fallback: string) => (err: unknown) => {
    const ended = endedStepNotice(err);
    if (ended === null) return toFailure(err, fallback);
    backToSignIn(warning(ended));
    return null;
  };

  const signIn = (address: string, password: string) => {
    setEmail(address);
    return attempt(
      () => authApi.login(address, password),
      proceed,
      (err) => toFailure(err, "We could not sign you in. Please try again."),
    );
  };

  const setNewPassword = (challengeId: string, newPassword: string) =>
    attempt(
      () => authApi.newPassword(challengeId, newPassword),
      proceed,
      stepError("We could not save your password. Please try again."),
    );

  const sendCode = (challengeId: string) =>
    attempt(
      () => authApi.sendVerificationCode(challengeId),
      () => undefined,
      stepError("We could not send a code. Please try again."),
    );

  const confirmCode = (challengeId: string, code: string) =>
    attempt(
      () => authApi.confirmVerificationCode(challengeId, code),
      proceed,
      stepError("We could not verify that code. Please try again."),
    );

  const requestReset = (address: string) =>
    attempt(
      () => authApi.forgotPassword(address),
      () => {
        setEmail(address);
        // The same message for every address: it must not reveal whether an account exists.
        go(
          { name: "reset-password" },
          info(`If an account exists for ${address}, we've sent it a verification code.`),
        );
      },
      (err) => toFailure(err, "We could not send a code. Please try again."),
    );

  const resetPassword = (code: string, newPassword: string) =>
    attempt(
      () => authApi.resetPassword(email, code, newPassword),
      () =>
        // Not signed in: the user signs in with the new password.
        backToSignIn(info("Your password has been changed. Sign in with your new password.")),
      toResetFailure,
    );

  // -- public sign-up: the email is recorded only by an answer that is still current, so a late
  // answer after Back or "Use a different email" changes neither the screen nor the email.
  const createAccount = (address: string, password: string, captchaToken: string) =>
    attempt(
      () => authApi.signUp(address, password, captchaToken),
      () => {
        setEmail(address);
        go({ name: "verify-signup", email: address });
      },
      (err) => toCodedFailure(err, "We could not create your account. Please try again."),
    );

  const confirmSignUp = (address: string, code: string) =>
    attempt(
      () => authApi.confirmSignUp(address, code),
      () => {
        setEmail(address);
        backToSignIn(info("Your email is verified. Sign in with your email and password."));
      },
      (err) => toCodedFailure(err, "We could not verify that code. Please try again."),
    );

  const resendSignUpCode = (address: string) =>
    attempt(
      () => authApi.resendSignUpCode(address),
      () => undefined,
      (err) => toCodedFailure(err, "We could not send a code. Please try again."),
    );

  const common = { focusTitle: navigated, notice: screenNotice };

  switch (screen.name) {
    case "sign-in":
      return (
        <AuthCard key={screen.name} title="Sign in to MyDubb" {...common}>
          <SignInForm
            initialEmail={email}
            onSubmit={signIn}
            guest={guest}
            chromeExtension={chromeExtension}
            signup={
              signup
                ? {
                    freePlan: signup.freePlan,
                    onCreateAccount: (address) => {
                      setEmail(address);
                      go({ name: "create-account" });
                    },
                    onVerifyEmail: (address) => go({ name: "verify-signup", email: address || null }),
                  }
                : undefined
            }
            onForgotPassword={
              passwordReset
                ? (address) => {
                    setEmail(address);
                    go({ name: "forgot-password" });
                  }
                : undefined
            }
          />
        </AuthCard>
      );
    case "new-password":
      return (
        <AuthCard
          key={screen.name}
          title="Set your password"
          intro="You signed in with a temporary password. Choose a new one to continue."
          {...common}
        >
          <NewPasswordForm
            onSubmit={(password) => setNewPassword(screen.challengeId, password)}
            onCancel={() => backToSignIn()}
          />
        </AuthCard>
      );
    case "verify-email":
      return (
        <AuthCard
          key={screen.name}
          title="Verify your email"
          intro="We need to confirm your email address. Press Send code, then enter the code we email you."
          {...common}
        >
          <VerifyEmailForm
            onConfirm={(code) => confirmCode(screen.challengeId, code)}
            onResend={() => sendCode(screen.challengeId)}
            onCancel={() => backToSignIn()}
          />
        </AuthCard>
      );
    case "forgot-password":
      return (
        <AuthCard
          key={screen.name}
          title="Reset your password"
          intro="Enter your email and we'll send a verification code."
          {...common}
        >
          <ForgotPasswordForm
            initialEmail={email}
            onSubmit={requestReset}
            onBack={() => backToSignIn()}
          />
        </AuthCard>
      );
    case "reset-password":
      return (
        <AuthCard key={screen.name} title="Choose a new password" {...common}>
          <ResetPasswordForm
            onSubmit={resetPassword}
            onRequestNewCode={() => go({ name: "forgot-password" })}
            onBack={() => backToSignIn()}
          />
        </AuthCard>
      );
    case "create-account":
      // Reachable from the Sign in screen, or first at /signup; both only when sign-up is on.
      if (!signup) return null;
      return (
        <AuthCard key={screen.name} title="Create your account" {...common}>
          <CreateAccountForm
            siteKey={signup.recaptchaSiteKey}
            freePlan={signup.freePlan}
            initialEmail={email}
            onSubmit={createAccount}
            onHaveCode={(address) => go({ name: "verify-signup", email: address })}
            onBackToSignIn={() => backToSignIn()}
          />
        </AuthCard>
      );
    case "verify-signup":
      return (
        <AuthCard
          // A new form for each address, so nothing typed for one email stays for another.
          key={`${screen.name}:${screen.email ?? ""}`}
          title="Verify your email"
          intro={
            screen.email ? (
              <>
                If <strong>{screen.email}</strong> can be used for a new account, we sent it a
                code. Enter it to finish, or use Resend code if none arrives. If you already have
                an account, sign in or use Forgot password.
              </>
            ) : (
              "Enter the email you used to create your account and the code we sent to it."
            )
          }
          {...common}
        >
          <VerifySignupForm
            email={screen.email}
            onConfirm={confirmSignUp}
            onResend={resendSignUpCode}
            onChangeEmail={(address) => {
              setEmail(address);
              go({ name: "create-account" });
            }}
            onBackToSignIn={() => backToSignIn()}
          />
        </AuthCard>
      );
  }
}
