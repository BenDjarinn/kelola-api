import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db/index.js";
import { messages, users } from "../db/schema.js";

export const MAX_MESSAGE_LENGTH = 4000;

export interface DiscussionMessage {
  authorAvatarUrl: string | null;
  authorName: string;
  content: string;
  createdAt: Date;
  id: string;
  updatedAt: Date;
  userId: string;
}

export class MessageAccessError extends Error {
  readonly status: 403 | 404;

  constructor(message: string, status: 403 | 404) {
    super(message);
    this.name = "MessageAccessError";
    this.status = status;
  }
}

/**
 * Pure rule, separated so it is testable without a database and impossible to
 * forget at a call site: only the author may change their own message.
 */
export function canModifyMessage(messageAuthorId: string, actingUserId: string): boolean {
  return messageAuthorId === actingUserId;
}

async function loadMessageWithAuthor(messageId: string): Promise<DiscussionMessage | undefined> {
  const [row] = await db
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
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
    .limit(1);

  return row;
}

export async function createMessage(input: {
  content: string;
  projectId: string;
  userId: string;
  workspaceId: string;
}): Promise<DiscussionMessage> {
  const [inserted] = await db
    .insert(messages)
    .values({
      content: input.content,
      projectId: input.projectId,
      // Taken from the project row by the caller, never from the client payload.
      workspaceId: input.workspaceId,
      userId: input.userId,
    })
    .returning({ id: messages.id });

  const created = await loadMessageWithAuthor(inserted!.id);

  if (!created) {
    throw new MessageAccessError("Message not found after insert", 404);
  }

  return created;
}

/**
 * Loads a message and verifies the acting user may change it.
 *
 * Both "missing" and "someone else's" are checked here rather than at each call
 * site, so edit and delete cannot drift apart.
 */
async function assertOwnMessage(messageId: string, userId: string) {
  const [row] = await db
    .select({
      id: messages.id,
      projectId: messages.projectId,
      userId: messages.userId,
    })
    .from(messages)
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
    .limit(1);

  if (!row) {
    throw new MessageAccessError("Message not found", 404);
  }

  if (!canModifyMessage(row.userId, userId)) {
    throw new MessageAccessError("You can only change your own messages", 403);
  }

  return row;
}

export async function editMessage(input: {
  content: string;
  messageId: string;
  userId: string;
}): Promise<DiscussionMessage> {
  const existing = await assertOwnMessage(input.messageId, input.userId);

  await db
    .update(messages)
    .set({ content: input.content, updatedAt: new Date() })
    .where(eq(messages.id, existing.id));

  const updated = await loadMessageWithAuthor(existing.id);

  if (!updated) {
    throw new MessageAccessError("Message not found", 404);
  }

  return updated;
}

export async function deleteMessage(input: {
  messageId: string;
  userId: string;
}): Promise<{ messageId: string; projectId: string }> {
  const existing = await assertOwnMessage(input.messageId, input.userId);

  // Soft delete, per the project-wide rule — rows are never removed.
  await db
    .update(messages)
    .set({ deletedAt: new Date() })
    .where(eq(messages.id, existing.id));

  return { messageId: existing.id, projectId: existing.projectId };
}
