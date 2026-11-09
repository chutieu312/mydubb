// Google reCAPTCHA v2 Checkbox, loaded only when the Create account screen opens (never on the
// Sign in page), once per page load. Explicit rendering (developers.google.com/recaptcha/docs/
// display): the script calls `onload` when the API is ready; widgets are drawn with render().
// The backend verifies every token with Google; nothing here decides whether someone may sign up.

export interface RecaptchaApi {
  render: (
    container: HTMLElement,
    parameters: {
      sitekey: string;
      theme?: "light" | "dark";
      size?: "normal" | "compact";
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ) => number;
  reset: (widgetId?: number) => void;
}

declare global {
  interface Window {
    grecaptcha?: RecaptchaApi;
    mydubbRecaptchaReady?: () => void;
  }
}

const SCRIPT_URL =
  "https://www.google.com/recaptcha/api.js?render=explicit&onload=mydubbRecaptchaReady&hl=en";

let loading: Promise<RecaptchaApi> | null = null;

/** The reCAPTCHA API, loading Google's script the first time. A failed load can be retried. */
export function loadRecaptcha(): Promise<RecaptchaApi> {
  if (loading) return loading;
  loading = new Promise<RecaptchaApi>((resolve, reject) => {
    const script = document.createElement("script");
    const fail = () => {
      loading = null;
      script.remove();
      reject(new Error("The robot check could not be loaded."));
    };
    window.mydubbRecaptchaReady = () => {
      if (window.grecaptcha) resolve(window.grecaptcha);
      else fail();
    };
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return loading;
}
