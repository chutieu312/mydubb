import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { applyTheme, readStoredTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/app.css";

// Apply the saved appearance before the first render (light unless the user chose dark).
applyTheme(readStoredTheme());

const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
