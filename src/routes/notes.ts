import { and, desc, eq, isNull, isNotNull } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { db } from "../db/index.js";
import { noteDocuments, users } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { createNoteSchema, updateNoteSchema } from "../services/note.service.js";
import { assertProjectAccess, ProjectAccessError } from "../services/project-access.service.js";

import type { NextFunction, Response } from "express";

export const notesRouter = Router();

notesRouter.use(requireAuth);

/** Columns shared by list and detail, minus the body. */
const listColumns = {
  assigneeId: noteDocuments.assigneeId,
  assigneeName: users.name,
  createdAt: noteDocuments.createdAt,
  dueDate: noteDocuments.dueDate,
  id: noteDocuments.id,
  status: noteDocuments.status,
  title: noteDocuments.title,
  updatedAt: noteDocuments.updatedAt,
};

function handleError(error: unknown, response: Response, next: NextFunction): void {
  if (error instanceof ProjectAccessError) {
    response.status(error.status).json({ error: error.message });
    return;
  }

  next(error);
}

/**
 * Loads a note and checks the caller may reach its project.
 *
 * Authorisation always goes through the note's own project, never a project id
 * from the request — otherwise a caller could pass a project they belong to and
 * edit a note from one they do not.
 */
async function loadAccessibleNote(noteId: string, userId: string) {
  const [note] = await db
    .select({
      id: noteDocuments.id,
      projectId: noteDocuments.projectId,
      workspaceId: noteDocuments.workspaceId,
    })
    .from(noteDocuments)
    .where(eq(noteDocuments.id, noteId))
    .limit(1);

  if (!note) {
    throw new ProjectAccessError("Note not found", 404);
  }

  await assertProjectAccess(userId, note.projectId);

  return note;
}

/** Notes in a project, newest edit first, without bodies to keep the list light. */
notesRouter.get("/", async (request, response, next) => {
  try {
    const userId = request.user!.id;

    const parsed = z.object({ projectId: z.uuid() }).safeParse(request.query);

    if (!parsed.success) {
      response.status(400).json({ error: "projectId must be a UUID" });
      return;
    }

    await assertProjectAccess(userId, parsed.data.projectId);

    const rows = await db
      .select(listColumns)
      .from(noteDocuments)
      .leftJoin(users, eq(users.id, noteDocuments.assigneeId))
      .where(
        and(eq(noteDocuments.projectId, parsed.data.projectId), isNull(noteDocuments.deletedAt)),
      )
      .orderBy(desc(noteDocuments.updatedAt));

    response.json({ notes: rows });
  } catch (error) {
    handleError(error, response, next);
  }
});

/** Soft-deleted notes, so they can be restored. */
notesRouter.get("/archived", async (request, response, next) => {
  try {
    const userId = request.user!.id;

    const parsed = z.object({ projectId: z.uuid() }).safeParse(request.query);

    if (!parsed.success) {
      response.status(400).json({ error: "projectId must be a UUID" });
      return;
    }

    await assertProjectAccess(userId, parsed.data.projectId);

    const rows = await db
      .select(listColumns)
      .from(noteDocuments)
      .leftJoin(users, eq(users.id, noteDocuments.assigneeId))
      .where(
        and(
          eq(noteDocuments.projectId, parsed.data.projectId),
          isNotNull(noteDocuments.deletedAt),
        ),
      )
      .orderBy(desc(noteDocuments.updatedAt));

    response.json({ notes: rows });
  } catch (error) {
    handleError(error, response, next);
  }
});

notesRouter.post("/", async (request, response, next) => {
  try {
    const userId = request.user!.id;

    const parsed = createNoteSchema.safeParse(request.body);

    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }

    // workspaceId from the project row, never the payload.
    const project = await assertProjectAccess(userId, parsed.data.projectId);

    const [created] = await db
      .insert(noteDocuments)
      .values({
        createdBy: userId,
        projectId: project.id,
        title: parsed.data.title,
        workspaceId: project.workspaceId,
      })
      .returning({ id: noteDocuments.id });

    response.status(201).json({ id: created!.id });
  } catch (error) {
    handleError(error, response, next);
  }
});

notesRouter.get("/:noteId", async (request, response, next) => {
  try {
    const userId = request.user!.id;
    const noteId = request.params.noteId;

    if (!z.uuid().safeParse(noteId).success) {
      response.status(400).json({ error: "noteId must be a UUID" });
      return;
    }

    await loadAccessibleNote(noteId, userId);

    const [note] = await db
      .select({ ...listColumns, body: noteDocuments.body, deletedAt: noteDocuments.deletedAt })
      .from(noteDocuments)
      .leftJoin(users, eq(users.id, noteDocuments.assigneeId))
      .where(eq(noteDocuments.id, noteId))
      .limit(1);

    response.json({ note });
  } catch (error) {
    handleError(error, response, next);
  }
});

/** Partial update. This is the endpoint autosave calls on every debounce. */
notesRouter.patch("/:noteId", async (request, response, next) => {
  try {
    const userId = request.user!.id;
    const noteId = request.params.noteId;

    if (!z.uuid().safeParse(noteId).success) {
      response.status(400).json({ error: "noteId must be a UUID" });
      return;
    }

    const parsed = updateNoteSchema.safeParse(request.body);

    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }

    await loadAccessibleNote(noteId, userId);

    await db
      .update(noteDocuments)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(noteDocuments.id, noteId));

    response.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (error) {
    handleError(error, response, next);
  }
});

notesRouter.delete("/:noteId", async (request, response, next) => {
  try {
    const userId = request.user!.id;
    const noteId = request.params.noteId;

    if (!z.uuid().safeParse(noteId).success) {
      response.status(400).json({ error: "noteId must be a UUID" });
      return;
    }

    await loadAccessibleNote(noteId, userId);

    // Soft delete per the project-wide rule, which is also what makes letting any
    // member delete acceptable — nothing is actually lost.
    await db
      .update(noteDocuments)
      .set({ deletedAt: new Date() })
      .where(eq(noteDocuments.id, noteId));

    response.json({ ok: true });
  } catch (error) {
    handleError(error, response, next);
  }
});

notesRouter.post("/:noteId/restore", async (request, response, next) => {
  try {
    const userId = request.user!.id;
    const noteId = request.params.noteId;

    if (!z.uuid().safeParse(noteId).success) {
      response.status(400).json({ error: "noteId must be a UUID" });
      return;
    }

    await loadAccessibleNote(noteId, userId);

    await db
      .update(noteDocuments)
      .set({ deletedAt: null })
      .where(eq(noteDocuments.id, noteId));

    response.json({ ok: true });
  } catch (error) {
    handleError(error, response, next);
  }
});
