export interface NewPasswordErrors {
  password?: string;
  confirm?: string;
}

/**
 * Only what the browser can know for sure. The password rules belong to the identity service and
 * are not published by the backend, so the server's answer (`password_rejected`) decides.
 */
export function validateNewPassword(password: string, confirm: string): NewPasswordErrors {
  return confirm === password ? {} : { confirm: "The two passwords do not match." };
}

export const CODE_FORMAT_TEXT = "Enter the numeric code from the email (digits only).";

/** Drops spaces users copy along with a code; the contract accepts 1 to 10 digits. */
export const normalizeCode = (code: string) => code.replace(/\s+/g, "");

export const isValidCode = (code: string) => /^\d{1,10}$/.test(code);
