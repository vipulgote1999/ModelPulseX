/** @type {import('tailwindcss').Config} */
export default {
  content: ["./frontend/index.html", "./frontend/src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(240 5% 18%)",
        card: "hsl(240 6% 10%)",
        muted: "hsl(240 3% 14%)",
      },
    },
  },
  plugins: [],
};
