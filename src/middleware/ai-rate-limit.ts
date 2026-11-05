import { and, count, eq, gte, isNull } from "drizzle-orm";

import { db } from "../db/index.js";
import { aiMessages } from "../db/schema.js";
import { env } from "../env.js";

import type { NextFunction, Request, Response } from "express";

export interface RateLimitVerdict {
  isAllowed: boolean;
  reason?: "user" | "global";
}

export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Pure decision step, split out so the boundary is unit-testable without a
 * database. "At the limit" is already spent — the next message is the one over.
 */
export function evaluateRateLimit(
  userMessagesToday: number,
  globalMessagesToday: number,
  limits: { global: number; perUser: number },
): RateLimitVerdict {
  if (userMessagesToday >= limits.perUser) {
    return { isAllowed: false, reason: "user" };
  }

  if (globalMessagesToday >= limits.global) {
    return { isAllowed: false, reason: "global" };
  }

  return { isAllowed: true };
}

async function countMessagesSince(since: Date, userId?: string): Promise<number> {
  const conditions = [
    eq(aiMessages.role, "user"),
    gte(aiMessages.createdAt, since),
    isNull(aiMessages.deletedAt),
  ];

  if (userId) {
    conditions.push(eq(aiMessages.userId, userId));
  }

  const [row] = await db
    .select({ total: count() })
    .from(aiMessages)
    .where(and(...conditions));

  return row?.total ?? 0;
}

/**
 * Daily caps on AI messages.
 *
 * Counted from ai_messages rather than an in-memory counter so the limit survives
 * restarts and works if the API ever runs more than one instance. Two COUNTs per
 * chat request is negligible next to the Gemini call itself.
 *
 * The global cap exists because Gemini's free tier is shared across every user of
 * the app — without it one person can exhaust the day for everyone.
 */
export async function aiRateLimit(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = request.user?.id;

    if (!userId) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const since = startOfUtcDay();

    const [userMessagesToday, globalMessagesToday] = await Promise.all([
      countMessagesSince(since, userId),
      countMessagesSince(since),
    ]);

    const verdict = evaluateRateLimit(userMessagesToday, globalMessagesToday, {
      global: env.AI_DAILY_LIMIT_GLOBAL,
      perUser: env.AI_DAILY_LIMIT_PER_USER,
    });

    if (!verdict.isAllowed) {
      response.status(429).json({
        error:
          verdict.reason === "user"
            ? `You have reached today's limit of ${env.AI_DAILY_LIMIT_PER_USER} AI messages.`
            : "Kelola AI has reached its daily limit. Please try again tomorrow.",
      });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}
