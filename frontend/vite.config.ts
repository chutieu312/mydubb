import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the Vite server proxies /api to the FastAPI backend.
// In production FastAPI serves the built files itself (same origin).
const backend = process.env.MYDUBB_BACKEND_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
