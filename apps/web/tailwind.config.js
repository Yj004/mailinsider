/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      fontFamily: {
        sans: ["IBM Plex Sans", "Segoe UI", "sans-serif"],
        display: ["Sora", "IBM Plex Sans", "sans-serif"],
      },
      colors: {
        ink: "#202124",
        muted: "#5f6368",
        line: "#e0e3e7",
        canvas: "#f6f8fc",
        brand: "#0b57d0",
        gmail: {
          blue: "#1a73e8",
          ink: "#0b57d0",
          soft: "#d3e3fd",
          surface: "#f6f8fc",
          compose: "#c2e7ff",
        },
      },
      boxShadow: {
        card: "0 1px 2px rgba(15, 23, 42, 0.04)",
      },
    },
  },
  plugins: [],
}
