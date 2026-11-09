import { StrictMode } from "react";
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

// The Chrome extension's sign-in window (docs/EXTENSION_AUTH.md) is its own small page.
const page = window.location.pathname === "/extension/connect" ? <ExtensionConnect /> : <App />;

createRoot(root).render(<StrictMode>{page}</StrictMode>);
