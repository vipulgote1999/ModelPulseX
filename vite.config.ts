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
    // Security: restrict file system access to project root (prevent --fs.allow escape)
    fs: {
      allow: [resolve(__dirname, "frontend"), resolve(__dirname, "dist")],
      deny: [".env", ".env.*", "*.pem", "*.key", ".git", ".wrangler"],
      strict: true,
    },
    // Security headers for dev server (mirrors prod)
    headers: {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' http://127.0.0.1:8787 ws://127.0.0.1:5173 https: wss:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    },
  },
});
