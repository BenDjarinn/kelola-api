import { config as loadEnvFile } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Matches src/env.ts: Neon's CLI writes DATABASE_URL into .env.local.
loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ path: ".env", quiet: true });

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
