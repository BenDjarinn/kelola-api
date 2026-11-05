import { randomUUID } from "node:crypto";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { accounts, sessions, users, verifications } from "../db/schema.js";
import { corsOrigins, env } from "../env.js";
import { joinDefaultWorkspace } from "../services/workspace-membership.service.js";

const isProduction = env.NODE_ENV === "production";

/**
 * Whether the browser considers the app and this API different *sites*.
 *
 * With COOKIE_DOMAIN set to a domain we own (".kelola.app"), app.kelola.app and
 * api.kelola.app are the same site, and SameSite=Lax is both sufficient and the
 * stricter choice. Without it the pair is Vercel + Railway — different registrable
 * domains, which is cross-site. A Lax cookie is never attached to a cross-site
 * fetch(), so sign-in would return 200 and every request after it 401; the failure
 * looks like "the session is not saved" rather than anything to do with cookies.
 *
 * SameSite=None is the only value a browser sends cross-site, and it is honoured
 * only together with Secure, hence https in production.
 *
 * Pointing COOKIE_DOMAIN at ".vercel.app" is not an alternative: that domain is on
 * the Public Suffix List, so browsers reject it as a cookie domain outright.
 */
const isCrossSite = !env.COOKIE_DOMAIN;

export const auth = betterAuth({
  appName: "Kelola",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: corsOrigins,

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      account: accounts,
      session: sessions,
      user: users,
      verification: verifications,
    },
  }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // Turn on once transactional email is wired up; leaving it false lets
    // register -> login work end to end today.
    requireEmailVerification: false,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  user: {
    additionalFields: {
      // Surfaced on the session so requireAuth can reject soft-deleted users
      // without a second query. input: false keeps clients from setting it.
      deletedAt: {
        type: "date",
        input: false,
        required: false,
      },
    },
  },

  databaseHooks: {
    user: {
      create: {
        /**
         * Auto-join every new registration to the default workspace.
         *
         * Runs *after* the user row exists so the membership has something to
         * reference. joinDefaultWorkspace never throws — a failure here must not
         * turn a successful sign-up into an error.
         */
        after: async (user) => {
          await joinDefaultWorkspace(user.id);
        },
      },
    },

    session: {
      create: {
        /**
         * Better Auth has no concept of deleted_at, so without this a soft-deleted
         * user can still sign in and be handed a valid session. requireAuth blocks
         * them from protected routes, but the sign-in endpoint itself must not
         * report success. Verified by test: sign-in now 401s while deleted_at is set.
         */
        before: async (session) => {
          const [existingUser] = await db
            .select({ deletedAt: users.deletedAt })
            .from(users)
            .where(eq(users.id, session.userId))
            .limit(1);

          if (existingUser?.deletedAt) {
            // Same wording as a bad password: do not reveal that the account exists
            // but was deleted.
            throw new APIError("UNAUTHORIZED", { message: "Invalid email or password" });
          }

          return { data: session };
        },
      },
    },
  },

  advanced: {
    database: {
      // Every id column is uuid; without this Better Auth generates its own
      // string ids and the inserts fail against a uuid column.
      generateId: () => randomUUID(),
    },
    // Lets the session cookie be sent from app.<domain> to api.<domain>.
    // Unset in development, where localhost:3000 and :4000 are already same-site.
    ...(env.COOKIE_DOMAIN
      ? { crossSubDomainCookies: { enabled: true, domain: env.COOKIE_DOMAIN } }
      : {}),
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: isProduction && isCrossSite ? "none" : "lax",
      secure: isProduction,
    },
  },
});

export type Session = typeof auth.$Infer.Session;
