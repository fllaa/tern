import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri expects a fixed dev port and handles its own console output.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
