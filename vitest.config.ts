import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // src/env.ts validates on import and calls process.exit(1) when a variable is
    // missing, which would kill the test runner itself. These are throwaway values
    // that satisfy the schema; no test makes a real network or database call.
    env: {
      BETTER_AUTH_SECRET: "test-secret-value-that-is-long-enough-32",
      BETTER_AUTH_URL: "http://localhost:4000",
      DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/test",
      GEMINI_API_KEY: "test-key",
      NODE_ENV: "test",
    },
  },
});
