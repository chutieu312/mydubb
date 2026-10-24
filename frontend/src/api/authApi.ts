import { ApiError, request } from "./client";
import { isAuthStep, isMeResponse, type AuthStep, type MeResponse } from "./authTypes";

// Adapter for the email + password sign-in API (paths are PROVISIONAL, see authTypes.ts).
// Request bodies carry credentials: nothing here logs, stores or echoes them.

const UNEXPECTED = "The server sent an unexpected response. Please try again.";

function step(payload: unknown): AuthStep {
  if (!isAuthStep(payload)) throw new ApiError(502, "unexpected_response", UNEXPECTED);
  return payload;
}

export const authApi = {
  login: async (email: string, password: string): Promise<AuthStep> =>
    step(await request<unknown>("POST", "/api/auth/login", { body: { email, password } })),

  newPassword: async (challengeId: string, newPassword: string): Promise<AuthStep> =>
    step(
      await request<unknown>("POST", "/api/auth/new-password", {
        body: { challenge_id: challengeId, new_password: newPassword },
      }),
    ),

  sendVerificationCode: (challengeId: string) =>
    request<void>("POST", "/api/auth/email-verification/send", {
      body: { challenge_id: challengeId },
    }),

  confirmVerificationCode: async (challengeId: string, code: string): Promise<AuthStep> =>
    step(
      await request<unknown>("POST", "/api/auth/email-verification/confirm", {
        body: { challenge_id: challengeId, code },
      }),
    ),

  forgotPassword: (email: string) =>
    request<void>("POST", "/api/auth/forgot-password", { body: { email } }),

  resetPassword: (email: string, code: string, newPassword: string) =>
    request<void>("POST", "/api/auth/reset-password", {
      body: { email, code, new_password: newPassword },
    }),

  me: async (): Promise<MeResponse> => {
    const payload = await request<unknown>("GET", "/api/auth/me");
    if (!isMeResponse(payload)) throw new ApiError(502, "unexpected_response", UNEXPECTED);
    return payload;
  },

  logout: () => request<void>("POST", "/api/auth/logout"),
};
