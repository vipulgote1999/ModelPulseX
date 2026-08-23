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
    cssCodeSplit: true,
    chunkSizeWarningLimit: 600,
    minify: "esbuild",
    // disable eager modulepreload for lazy recharts — was 612ms preload even though lazy
    modulePreload: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          // recharts intentionally NOT manualChunk — let dynamic import split it so it loads only when charts visible
        },
      },
    },
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
