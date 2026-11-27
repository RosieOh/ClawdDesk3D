/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        clay: { 50: '#f6f1ea', 100: '#ece3d6', 300: '#d8b89a', 500: '#c8734f', 700: '#8e4a31' },
        te: { orange: '#ff5a1f' },
      },
    },
  },
  plugins: [],
};
