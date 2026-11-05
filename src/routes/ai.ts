import { and, asc, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { db } from "../db/index.js";
import { aiMessages } from "../db/schema.js";
import { aiRateLimit } from "../middleware/ai-rate-limit.js";
import { parseAiChatAttachments } from "../middleware/ai-chat-attachments.js";
import { requireAuth } from "../middleware/auth.js";
import {
  AiAttachmentProcessingError,
  prepareAiAttachmentParts,
} from "../services/ai-attachment.service.js";
import {
  AiGenerationError,
  buildConversationContext,
  generateAiReply,
} from "../services/ai.service.js";
import { assertProjectAccess, ProjectAccessError } from "../services/project-access.service.js";

import type { ConversationTurn } from "../services/ai.service.js";

const MAX_HISTORY_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_MESSAGE_LENGTH = 4000;

const historyQuerySchema = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().positive().max(MAX_HISTORY_LIMIT).default(DEFAULT_HISTORY_LIMIT),
});

const chatBodySchema = z.object({
  content: z.string().trim().min(1, "Message cannot be empty").max(MAX_MESSAGE_LENGTH),
  projectId: z.uuid("projectId must be a UUID"),
});

export const aiRouter = Router();

aiRouter.use(requireAuth);

/**
 * Conversation history for one project, oldest first.
 *
 * Paginated from the start: a long-lived AI channel grows without bound, and
 * adding pagination later means reconciling it against already-shipped clients.
 */
aiRouter.get("/chat/:projectId", async (request, response, next) => {
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

    const conditions = [eq(aiMessages.projectId, projectId), isNull(aiMessages.deletedAt)];

    if (before) {
      conditions.push(lt(aiMessages.createdAt, new Date(before)));
    }

    // Fetch newest-first so the cursor takes the most recent page, then flip to
    // chronological order for display.
    const rows = await db
      .select({
        content: aiMessages.content,
        createdAt: aiMessages.createdAt,
        id: aiMessages.id,
        role: aiMessages.role,
        userId: aiMessages.userId,
      })
      .from(aiMessages)
      .where(and(...conditions))
      .orderBy(desc(aiMessages.createdAt))
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

/**
 * Send a message and get a reply.
 *
 * The user message is saved before calling Gemini, per the agreed flow. If Gemini
 * then fails, that message stays in history with no reply — the user does not lose
 * what they typed, and a retry endpoint can pick it up later.
 */
aiRouter.post("/chat", aiRateLimit, parseAiChatAttachments, async (request, response, next) => {
  try {
    const userId = request.user!.id;

    const parsedBody = chatBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      response.status(400).json({ error: parsedBody.error.issues[0]?.message ?? "Invalid body" });
      return;
    }

    const { content, projectId } = parsedBody.data;
    const attachments = Array.isArray(request.files) ? request.files : [];

    // workspaceId comes from the project row, never from the request body.
    const project = await assertProjectAccess(userId, projectId);
    const attachmentParts = await prepareAiAttachmentParts(attachments);

    const [savedUserMessage] = await db
      .insert(aiMessages)
      .values({
        content,
        projectId: project.id,
        role: "user",
        userId,
        workspaceId: project.workspaceId,
      })
      .returning({ createdAt: aiMessages.createdAt, id: aiMessages.id });

    const history = await db
      .select({ content: aiMessages.content, role: aiMessages.role })
      .from(aiMessages)
      .where(and(eq(aiMessages.projectId, project.id), isNull(aiMessages.deletedAt)))
      .orderBy(asc(aiMessages.createdAt));

    const contents = buildConversationContext(
      history as ConversationTurn[],
      undefined,
      attachmentParts,
    );

    let replyText: string;

    try {
      replyText = await generateAiReply(contents);
    } catch (error) {
      if (error instanceof AiGenerationError) {
        response.status(502).json({
          error: "Kelola AI could not answer right now. Your message was saved — try again.",
          userMessageId: savedUserMessage?.id,
        });
        return;
      }

      throw error;
    }

    const [savedReply] = await db
      .insert(aiMessages)
      .values({
        content: replyText,
        projectId: project.id,
        role: "assistant",
        // Null: authored by Gemini, not by a person.
        userId: null,
        workspaceId: project.workspaceId,
      })
      .returning({ createdAt: aiMessages.createdAt, id: aiMessages.id });

    response.status(201).json({
      reply: {
        content: replyText,
        createdAt: savedReply?.createdAt,
        id: savedReply?.id,
        role: "assistant",
      },
      userMessage: {
        content,
        createdAt: savedUserMessage?.createdAt,
        id: savedUserMessage?.id,
        role: "user",
      },
    });
  } catch (error) {
    if (error instanceof AiAttachmentProcessingError) {
      response.status(400).json({ error: error.message });
      return;
    }

    if (error instanceof ProjectAccessError) {
      response.status(error.status).json({ error: error.message });
      return;
    }

    next(error);
  }
});

/**
 * Replace the latest user prompt and regenerate its assistant reply.
 *
 * Only the newest user message is editable. Editing an older turn would create a
 * branch and silently invalidate every later answer, which this linear chat model
 * does not represent yet.
 */
aiRouter.patch("/chat/:messageId", aiRateLimit, async (request, response, next) => {
  try {
    const userId = request.user!.id;
    const parsedMessageId = z.uuid().safeParse(request.params.messageId);

    if (!parsedMessageId.success) {
      response.status(400).json({ error: "messageId must be a UUID" });
      return;
    }

    const messageId = parsedMessageId.data;

    const parsedBody = chatBodySchema.safeParse(request.body);

    if (!parsedBody.success) {
      response.status(400).json({ error: parsedBody.error.issues[0]?.message ?? "Invalid body" });
      return;
    }

    const { content, projectId } = parsedBody.data;
    const project = await assertProjectAccess(userId, projectId);

    const [messageToEdit] = await db
      .select({
        createdAt: aiMessages.createdAt,
        id: aiMessages.id,
        userId: aiMessages.userId,
      })
      .from(aiMessages)
      .where(
        and(
          eq(aiMessages.id, messageId),
          eq(aiMessages.projectId, project.id),
          eq(aiMessages.role, "user"),
          isNull(aiMessages.deletedAt),
        ),
      )
      .limit(1);

    if (!messageToEdit || messageToEdit.userId !== userId) {
      response.status(404).json({ error: "Message not found" });
      return;
    }

    const [latestUserMessage] = await db
      .select({ id: aiMessages.id })
      .from(aiMessages)
      .where(
        and(
          eq(aiMessages.projectId, project.id),
          eq(aiMessages.role, "user"),
          isNull(aiMessages.deletedAt),
        ),
      )
      .orderBy(desc(aiMessages.createdAt))
      .limit(1);

    if (latestUserMessage?.id !== messageToEdit.id) {
      response.status(409).json({ error: "Only the latest message can be edited" });
      return;
    }

    const editedAt = new Date();

    const [savedUserMessage] = await db
      .update(aiMessages)
      .set({ content, updatedAt: editedAt })
      .where(eq(aiMessages.id, messageToEdit.id))
      .returning({ createdAt: aiMessages.createdAt, id: aiMessages.id });

    await db
      .update(aiMessages)
      .set({ deletedAt: editedAt, updatedAt: editedAt })
      .where(
        and(
          eq(aiMessages.projectId, project.id),
          gt(aiMessages.createdAt, messageToEdit.createdAt),
          isNull(aiMessages.deletedAt),
        ),
      );

    const history = await db
      .select({ content: aiMessages.content, role: aiMessages.role })
      .from(aiMessages)
      .where(and(eq(aiMessages.projectId, project.id), isNull(aiMessages.deletedAt)))
      .orderBy(asc(aiMessages.createdAt));

    const contents = buildConversationContext(history as ConversationTurn[]);

    let replyText: string;

    try {
      replyText = await generateAiReply(contents);
    } catch (error) {
      if (error instanceof AiGenerationError) {
        response.status(502).json({
          error: "Your edited message was saved, but Kelola AI could not answer. Try again.",
          userMessageId: savedUserMessage?.id,
        });
        return;
      }

      throw error;
    }

    const [savedReply] = await db
      .insert(aiMessages)
      .values({
        content: replyText,
        projectId: project.id,
        role: "assistant",
        userId: null,
        workspaceId: project.workspaceId,
      })
      .returning({ createdAt: aiMessages.createdAt, id: aiMessages.id });

    response.json({
      reply: {
        content: replyText,
        createdAt: savedReply?.createdAt,
        id: savedReply?.id,
        role: "assistant",
      },
      userMessage: {
        content,
        createdAt: savedUserMessage?.createdAt,
        id: savedUserMessage?.id,
        role: "user",
      },
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      response.status(error.status).json({ error: error.message });
      return;
    }

    next(error);
  }
});
