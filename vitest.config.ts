import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Test config is intentionally separate from vite.config.ts so dev-server
// settings don't bleed into test runs and vice versa. jsdom enables hook /
// React component tests; existing FS/util tests run unaffected because they
// don't touch DOM globals.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
