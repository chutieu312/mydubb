// Simulated sign-up for the prototype preview (docs/SIGNUP_PREVIEW.md).
//
// Nothing here uses the network, storage or a real identity service. Outcomes depend only on the
// values below, so a Product Owner can reproduce every state on demand. The results are UI states
// ("verified", "expired", ...), not API contracts: the real endpoints, payloads and error codes
// are not decided, and this file is replaced when sign-up is integrated.

/** Verifies. Any other 6-digit code is "wrong". */
export const DEMO_CODE = "123456";
export const EXPIRED_CODE = "000000";
/** The verification service is temporarily unavailable. */
export const UNAVAILABLE_CODE = "999999";
/** Create account fails the first time and works on the retry (until Reset demo). */
export const BUSY_EMAIL = "busy@example.com";

/** A short wait so the pending state is visible. Tests pass 0. */
const DEFAULT_DELAY_MS = 600;
/** Resend cooldown shown in the preview (the real one will come from the server). */
export const RESEND_WAIT_SECONDS = 10;

export type CreateResult = "created" | "unavailable";
export type VerifyResult = "verified" | "wrong" | "expired" | "unavailable";

export interface MockSignup {
  createAccount: (email: string) => Promise<CreateResult>;
  verify: (code: string) => Promise<VerifyResult>;
  resend: () => Promise<void>;
  /** Forget what the demo remembers (the "busy" address works again on its second try only). */
  reset: () => void;
}

export function createMockSignup(delayMs: number = DEFAULT_DELAY_MS): MockSignup {
  let busyAlreadyFailed = false;
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

  return {
    async createAccount(email) {
      await wait();
      if (email.trim().toLowerCase() === BUSY_EMAIL && !busyAlreadyFailed) {
        busyAlreadyFailed = true;
        return "unavailable";
      }
      return "created";
    },
    async verify(code) {
      await wait();
      if (code === DEMO_CODE) return "verified";
      if (code === EXPIRED_CODE) return "expired";
      if (code === UNAVAILABLE_CODE) return "unavailable";
      return "wrong";
    },
    async resend() {
      await wait();
    },
    reset() {
      busyAlreadyFailed = false;
    },
  };
}

export interface CreateErrors {
  email?: string;
  password?: string;
  captcha?: string;
}

// Prototype-only rule, so the "weak password" state can be shown. The real password rules belong
// to the identity service and are not decided here.
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCreate(email: string, password: string, captcha: boolean): CreateErrors {
  const errors: CreateErrors = {};
  const address = email.trim();
  if (address === "") errors.email = "Enter your email address.";
  else if (!EMAIL_SHAPE.test(address)) {
    errors.email = "Enter a valid email address, like name@example.com.";
  }
  if (password === "") errors.password = "Enter a password.";
  else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (!captcha) errors.captcha = "Confirm you are not a robot to continue.";
  return errors;
}
