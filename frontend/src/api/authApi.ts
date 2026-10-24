import { ApiError, request } from "./client";
import {
  hasStatus,
  isAuthStep,
  isCodeSent,
  isSession,
  type AuthStep,
  type CodeSent,
  type Session,
} from "./authTypes";

// Adapter for the email + password sign-in API (docs/AUTH_API.md). Request bodies carry
// credentials: nothing here logs, stores or echoes them. Each call accepts only the status the
// contract names and validates the body; anything else is an `unexpected_response`.

export const UNEXPECTED_RESPONSE = "unexpected_response";

function checked<T>(payload: unknown, guard: (value: unknown) => boolean): T {
  if (!guard(payload)) {
    throw new ApiError(502, UNEXPECTED_RESPONSE, "The server sent an unexpected response.");
  }
  return payload as T;
}

export const authApi = {
  login: async (email: string, password: string): Promise<AuthStep> =>
    checked(
      await request<unknown>("POST", "/api/auth/login", {
        body: { email, password },
        accept: [200],
      }),
      isAuthStep,
    ),

  newPassword: async (challengeId: string, newPassword: string): Promise<AuthStep> =>
    checked(
      await request<unknown>("POST", "/api/auth/new-password", {
        body: { challenge_id: challengeId, new_password: newPassword },
        accept: [200],
      }),
      isAuthStep,
    ),

  sendVerificationCode: async (challengeId: string): Promise<CodeSent> =>
    checked(
      await request<unknown>("POST", "/api/auth/email-verification/send", {
        body: { challenge_id: challengeId },
        accept: [200],
      }),
      isCodeSent,
    ),

  confirmVerificationCode: async (challengeId: string, code: string): Promise<AuthStep> =>
    checked(
      await request<unknown>("POST", "/api/auth/email-verification/confirm", {
        body: { challenge_id: challengeId, code },
        accept: [200],
      }),
      isAuthStep,
    ),

  forgotPassword: async (email: string): Promise<void> => {
    checked(
      await request<unknown>("POST", "/api/auth/forgot-password", {
        body: { email },
        accept: [202],
      }),
      hasStatus("accepted"),
    );
  },

  resetPassword: async (email: string, code: string, newPassword: string): Promise<void> => {
    checked(
      await request<unknown>("POST", "/api/auth/reset-password", {
        body: { email, code, new_password: newPassword },
        accept: [200],
      }),
      hasStatus("password_reset"),
    );
  },

  me: async (): Promise<Session> =>
    checked(await request<unknown>("GET", "/api/auth/me", { accept: [200] }), isSession),

  logout: () => request<void>("POST", "/api/auth/logout", { accept: [204] }),
};
