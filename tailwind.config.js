/** @type {import('tailwindcss').Config} */
export default {
  content: ["./frontend/index.html", "./frontend/src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(240 5% 18%)",
        card: "hsl(240 6% 10%)",
        muted: "hsl(240 3% 14%)",
        // ModelPulseX observatory tokens — single source of truth for palette.
        // Base surfaces (violet-tinted near-black, matches #0a0a0f bg):
        surface: {
          base: "#0a0a0f",
          raised: "#12121a",
          overlay: "#1a1a24",
          border: "#27272e",
        },
        // Brand gradient endpoints (Logo violet -> cyan). Reserve for
        // brand + primary CTAs + first two chart series only.
        brand: {
          violet: "#8b5cf6",
          cyan: "#22d3ee",
        },
        // Data series palette — colorblind-distinct on dark, stable order
        // across TPS/TTFT/ITL/Timeout charts. Never use semantic hues here
        // except series 3 (emerald) by position.
        data: {
          1: "#a78bfa",
          2: "#22d3ee",
          3: "#34d399",
          4: "#fbbf24",
          5: "#fb7185",
          6: "#60a5fa",
        },
      },
    },
  },
  plugins: [],
};
