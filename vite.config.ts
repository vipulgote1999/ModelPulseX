import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: "frontend",
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "frontend/src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
