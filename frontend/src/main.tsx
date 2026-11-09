import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ExtensionConnect } from "./features/extension/ExtensionConnect";
import { applyTheme, readStoredTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/app.css";

// Apply the saved appearance before the first render (light unless the user chose dark).
applyTheme(readStoredTheme());

const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");

// Sign-up prototype for the Product Owner (docs/SIGNUP_PREVIEW.md): simulated data, development
// only. Vite replaces `import.meta.env.DEV` with `false` in a production build, so this branch,
// the import and the preview's code and styles are not part of the built site.
const SignupPreview = import.meta.env.DEV
  ? lazy(() => import("./preview/signup/SignupPreview"))
  : null;
const SIGNUP_PREVIEW_PATH = "/preview/signup";

// The Chrome extension's sign-in window (docs/EXTENSION_AUTH.md) is its own small page.
const pathname = window.location.pathname;
const page =
  pathname === "/extension/connect" ? (
    <ExtensionConnect />
  ) : SignupPreview && pathname.replace(/\/+$/, "") === SIGNUP_PREVIEW_PATH ? (
    <Suspense fallback={null}>
      <SignupPreview />
    </Suspense>
  ) : (
    <App />
  );

createRoot(root).render(<StrictMode>{page}</StrictMode>);
