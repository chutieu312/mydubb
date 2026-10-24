import { useState } from "react";

import { authApi } from "../../api/authApi";
import type { AuthStep, AuthUser } from "../../api/authTypes";
import { setCsrfToken } from "../../api/client";
import { DEFAULT_PASSWORD_POLICY, type PasswordPolicy } from "../../lib/passwordPolicy";
import { AuthCard, type AuthNotice } from "./AuthCard";
import { isChallengeGone, toFailure, type Outcome } from "./errors";
import { ForgotPasswordForm, ResetPasswordForm } from "./ForgotPasswordForms";
import { NewPasswordForm } from "./NewPasswordForm";
import { SignInForm } from "./SignInForm";
import { VerifyEmailForm } from "./VerifyEmailForm";

// Everything here lives in component state (memory). The challenge id is an opaque server
// identifier, still never written to storage or the URL, and never logged. Passwords are held by
// the form that typed them and are gone when that form unmounts.
type Screen =
  | { name: "sign-in" }
  | { name: "new-password"; challengeId: string }
  | { name: "verify-email"; challengeId: string }
  | { name: "forgot-password" }
  | { name: "reset-password" };

interface Props {
  // Shown on the first sign-in screen, e.g. after the session expired.
  notice?: string | null;
  policy?: PasswordPolicy;
  onAuthenticated: (user: AuthUser) => void;
}

const CHALLENGE_EXPIRED: AuthNotice = {
  text: "That sign-in attempt expired. Please sign in again.",
  tone: "warning",
};

export function PasswordAuthFlow({
  notice,
  policy = DEFAULT_PASSWORD_POLICY,
  onAuthenticated,
}: Props) {
  const [screen, setScreen] = useState<Screen>({ name: "sign-in" });
  const [screenNotice, setScreenNotice] = useState<AuthNotice | null>(
    notice ? { text: notice, tone: "warning" } : null,
  );
  // False only for the first screen of a page load; later screens take focus.
  const [navigated, setNavigated] = useState(false);
  const [email, setEmail] = useState("");

  const go = (next: Screen, nextNotice: AuthNotice | null = null) => {
    setScreen(next);
    setScreenNotice(nextNotice);
    setNavigated(true);
  };
  const backToSignIn = (nextNotice: AuthNotice | null = null) =>
    go({ name: "sign-in" }, nextNotice);

  const proceed = (step: AuthStep) => {
    switch (step.status) {
      case "authenticated":
        if (step.csrf_token) setCsrfToken(step.csrf_token);
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

  // Runs a request; null means it succeeded, a Failure is what the form shows.
  const attempt = async (
    request: () => Promise<void>,
    fallback: string,
    onChallengeGone?: () => void,
  ): Promise<Outcome> => {
    try {
      await request();
      return null;
    } catch (err) {
      if (onChallengeGone && isChallengeGone(err)) {
        onChallengeGone();
        return null;
      }
      return toFailure(err, fallback);
    }
  };

  const signIn = (address: string, password: string) =>
    attempt(async () => {
      setEmail(address);
      proceed(await authApi.login(address, password));
    }, "We could not sign you in. Please try again.");

  const setNewPassword = (challengeId: string, newPassword: string) =>
    attempt(
      async () => proceed(await authApi.newPassword(challengeId, newPassword)),
      "We could not save your password. Please try again.",
      () => backToSignIn(CHALLENGE_EXPIRED),
    );

  const sendCode = (challengeId: string) =>
    attempt(
      () => authApi.sendVerificationCode(challengeId),
      "We could not send a code. Please try again.",
      () => backToSignIn(CHALLENGE_EXPIRED),
    );

  const confirmCode = (challengeId: string, code: string) =>
    attempt(
      async () => proceed(await authApi.confirmVerificationCode(challengeId, code)),
      "We could not verify that code. Please try again.",
      () => backToSignIn(CHALLENGE_EXPIRED),
    );

  const requestReset = (address: string) =>
    attempt(async () => {
      await authApi.forgotPassword(address);
      setEmail(address);
      // The same message for every address: it must not reveal whether an account exists.
      go({ name: "reset-password" }, {
        text: `If an account exists for ${address}, we've sent it a verification code.`,
        tone: "info",
      });
    }, "We could not send a code. Please try again.");

  const resetPassword = (code: string, newPassword: string) =>
    attempt(async () => {
      await authApi.resetPassword(email, code, newPassword);
      backToSignIn({
        text: "Your password has been changed. Sign in with your new password.",
        tone: "info",
      });
    }, "We could not reset your password. Check the code and try again.");

  const common = { focusTitle: navigated, notice: screenNotice };

  switch (screen.name) {
    case "sign-in":
      return (
        <AuthCard key={screen.name} title="Sign in to MyDubb" {...common}>
          <SignInForm
            initialEmail={email}
            onSubmit={signIn}
            onForgotPassword={(address) => {
              setEmail(address);
              go({ name: "forgot-password" });
            }}
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
            policy={policy}
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
          intro="We need to confirm your email address. Enter the code we send you."
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
            policy={policy}
            onSubmit={resetPassword}
            onRequestNewCode={() => go({ name: "forgot-password" })}
            onBack={() => backToSignIn()}
          />
        </AuthCard>
      );
  }
}
