import { config as loadEnvFile } from "dotenv";
import { z } from "zod";

// Neon's CLI writes DATABASE_URL into .env.local, so load that first — dotenv does
// not overwrite variables that are already set, which makes .env.local win over
// .env. Real process environment (Railway, Render) still beats both.
loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ path: ".env", quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  /** Neon pooled connection string — the host should contain "-pooler". */
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  /** Public origin of this API, used by Better Auth to build callback URLs. */
  BETTER_AUTH_URL: z.string().min(1, "BETTER_AUTH_URL is required"),
  /** Comma-separated list of browser origins allowed to call this API. */
  CORS_ORIGIN: z.string().min(1).default("http://localhost:3000"),
  /**
   * Shared parent domain for session cookies, e.g. ".kelola.app", so a cookie set
   * by api.kelola.app is sent by app.kelola.app. Leave unset in development.
   */
  COOKIE_DOMAIN: z.string().min(1).optional(),

  /**
   * Slug of a workspace that every new registration is auto-joined to.
   *
   * SECURITY: anyone who signs up can then read that workspace's discussions and
   * AI conversations. This is a development and demo convenience. Leave it UNSET
   * in production, where joining a workspace should require an invitation.
   */
  DEFAULT_WORKSPACE_SLUG: z.string().min(1).optional(),

  /**
   * Google AI Studio key. Optional *here* so that `db:migrate` and `db:seed` can
   * run without one — they have no business needing an AI key. The API server
   * still fails fast at boot, because ai.service.ts asserts it on import.
   */
  GEMINI_API_KEY: z.string().min(1).optional(),
  /**
   * Model id, not hardcoded: gemini-2.0-flash was shut down on 2026-06-01 mid
   * project. Keeping this in env makes the next retirement a one-line change.
   */
  GEMINI_MODEL: z.string().min(1).default("gemini-3.6-flash"),
  /**
   * Tried when the primary model returns 503 "high demand" on every attempt.
   * Observed 2026-11-05: gemini-3.6-flash and gemini-3.8-flash were both
   * intermittently overloaded while gemini-3.5-flash-lite stayed available.
   * Set to the same value as GEMINI_MODEL to disable the fallback.
   */
  GEMINI_FALLBACK_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  /** Prior turns sent to Gemini as context. Higher costs more tokens per call. */
  AI_CONTEXT_MESSAGE_COUNT: z.coerce.number().int().positive().max(100).default(20),
  /** Per-user messages per day. Guards one user burning the shared free quota. */
  AI_DAILY_LIMIT_PER_USER: z.coerce.number().int().positive().default(50),
  /** App-wide messages per day, the circuit breaker on the free tier. */
  AI_DAILY_LIMIT_GLOBAL: z.coerce.number().int().positive().default(500),
}).superRefine((value, ctx) => {
  // Defaults that are convenient in development are wrong in production: a
  // localhost CORS origin does not error, it silently denies the real browser
  // origin, which surfaces much later as an unexplained CORS failure.
  if (value.NODE_ENV !== "production") {
    return;
  }

  for (const key of ["BETTER_AUTH_URL", "CORS_ORIGIN"] as const) {
    if (/localhost|127\.0\.0\.1/.test(value[key])) {
      ctx.addIssue({
        code: "custom",
        message: `must be a public origin in production, got "${value[key]}"`,
        path: [key],
      });
    }
  }

  // Without COOKIE_DOMAIN the session cookie is cross-site, so it is sent with
  // SameSite=None, which browsers honour only on Secure (https) cookies. Over
  // http the cookie is dropped and nobody can stay signed in.
  if (!value.BETTER_AUTH_URL.startsWith("https://")) {
    ctx.addIssue({
      code: "custom",
      message: "must use https in production, or the session cookie is rejected",
      path: ["BETTER_AUTH_URL"],
    });
  }
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const details = parsedEnv.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  // Fail fast and loudly: a half-configured server is worse than one that refuses
  // to boot, and these values decide database and session behaviour.
  console.error(`Invalid environment variables:\n${details}`);
  process.exit(1);
}

export const env = parsedEnv.data;

export const corsOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim());

// Not a hard failure: a public demo may legitimately want it. But it must never be
// left on by accident, so say so once, loudly, where Railway's logs will show it.
if (env.NODE_ENV === "production" && env.DEFAULT_WORKSPACE_SLUG) {
  console.warn(
    `[security] DEFAULT_WORKSPACE_SLUG is set to "${env.DEFAULT_WORKSPACE_SLUG}" in ` +
      "production: every new sign-up can read that workspace. Unset it unless this " +
      "deployment is a public demo.",
  );
}
