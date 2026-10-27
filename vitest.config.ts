import { defineConfig } from "vitest/config";

// Unit tests only; tests/e2e runs under node:test against a real browser.
export default defineConfig({ test: { include: ["tests/unit/**/*.test.ts"] } });
