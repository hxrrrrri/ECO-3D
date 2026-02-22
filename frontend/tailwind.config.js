/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#0df2f2",
        "background-dark": "#080808",
        "background-light": "#f5f8f8",
        "neutral-dark": "#102222",
      },
      fontFamily: {
        display: ["Space Grotesk", "sans-serif"],
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "float": "float 6s ease-in-out infinite",
        "scan": "scan 3s linear infinite",
        "glow": "glow 2s ease-in-out infinite alternate",
      },
      keyframes: {
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-10px)" },
        },
        scan: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100vh)" },
        },
        glow: {
          "0%": { boxShadow: "0 0 20px rgba(13, 242, 242, 0.3)" },
          "100%": { boxShadow: "0 0 40px rgba(13, 242, 242, 0.6)" },
        },
      },
    },
  },
  plugins: [],
};
