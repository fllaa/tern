import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: test runs need neither the React
// plugin nor Tailwind, and keeping them out means a config change to the build
// cannot silently change what the tests exercise.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // Almost all the value is in pure logic, which needs no DOM. jsdom is
    // opt-in per file via a `@vitest-environment jsdom` docblock.
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
