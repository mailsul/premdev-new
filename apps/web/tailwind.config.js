/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "rgb(var(--color-bg) / <alpha-value>)",
          subtle: "rgb(var(--color-bg-subtle) / <alpha-value>)",
          panel: "rgb(var(--color-bg-panel) / <alpha-value>)",
          hover: "rgb(var(--color-bg-hover) / <alpha-value>)",
          border: "rgb(var(--color-bg-border) / <alpha-value>)",
        },
        text: {
          DEFAULT: "rgb(var(--color-text) / <alpha-value>)",
          muted: "rgb(var(--color-text-muted) / <alpha-value>)",
          subtle: "rgb(var(--color-text-subtle) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "#7c5cff",
          hover: "#9b80ff",
          muted: "#5b3fd9",
        },
        success: "#22c55e",
        warning: "#f59e0b",
        danger: "#ef4444",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "Fira Code",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        glow: "0 0 24px rgba(124, 92, 255, 0.35)",
      },
    },
  },
  plugins: [],
};
