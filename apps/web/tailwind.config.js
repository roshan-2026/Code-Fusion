/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        vscode: {
          dark: '#1e1e1e',
          darker: '#181818',
          sidebar: '#252526',
          activity: '#333333',
          border: '#3c3c3c',
          status: '#007acc',
          hover: '#2a2d2e',
          text: '#cccccc',
          brightText: '#ffffff',
        }
      }
    },
  },
  plugins: [],
};
