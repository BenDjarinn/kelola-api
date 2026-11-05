import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { db } from "../db/index.js";
import { messages, users } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { assertProjectAccess, ProjectAccessError } from "../services/project-access.service.js";

const MAX_HISTORY_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 50;

const historyQuerySchema = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().positive().max(MAX_HISTORY_LIMIT).default(DEFAULT_HISTORY_LIMIT),
});

export const messagesRouter = Router();

messagesRouter.use(requireAuth);

/**
 * Discussion history for one project, oldest first.
 *
 * History is served over REST rather than the socket so TanStack Query stays the
 * cache and a page refresh does not race the socket handshake. Live updates then
 * write into that same cache.
 */
messagesRouter.get("/:projectId", async (request, response, next) => {
  try {
    const userId = request.user!.id;
    const projectId = request.params.projectId;

    if (!z.uuid().safeParse(projectId).success) {
      response.status(400).json({ error: "projectId must be a UUID" });
      return;
    }

    const parsedQuery = historyQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      response.status(400).json({ error: parsedQuery.error.issues[0]?.message ?? "Invalid query" });
      return;
    }

    await assertProjectAccess(userId, projectId);

    const { before, limit } = parsedQuery.data;

    const conditions = [eq(messages.projectId, projectId), isNull(messages.deletedAt)];

    if (before) {
      conditions.push(lt(messages.createdAt, new Date(before)));
    }

    // Newest-first for the cursor, then reversed for chronological display.
    const rows = await db
      .select({
        authorAvatarUrl: users.image,
        authorName: users.name,
        content: messages.content,
        createdAt: messages.createdAt,
        id: messages.id,
        updatedAt: messages.updatedAt,
        userId: messages.userId,
      })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.userId))
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    response.json({
      messages: rows.reverse(),
      nextCursor: rows.length === limit ? rows[0]?.createdAt.toISOString() : null,
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      response.status(error.status).json({ error: error.message });
      return;
    }

    next(error);
  }
});
