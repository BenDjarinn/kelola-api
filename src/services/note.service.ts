import { z } from "zod";

export const MAX_TITLE_LENGTH = 200;

/**
 * Serialised body cap. BlockNote's JSON shape is the editor's concern so it is not
 * validated structurally, but an uncapped jsonb column lets any client push
 * unbounded data into Postgres.
 */
export const MAX_BODY_BYTES = 1_000_000;

export const NOTE_STATUSES = ["open", "in_progress", "done"] as const;

export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** Rejects bodies over the cap without trusting a client-supplied length. */
export function isBodyWithinLimit(body: unknown): boolean {
  if (body === undefined || body === null) {
    return true;
  }

  try {
    return Buffer.byteLength(JSON.stringify(body), "utf8") <= MAX_BODY_BYTES;
  } catch {
    // Circular or otherwise unserialisable input is not storable either.
    return false;
  }
}

const bodySchema = z
  .array(z.unknown())
  .refine(isBodyWithinLimit, { message: "Note content is too large" });

export const createNoteSchema = z.object({
  projectId: z.uuid(),
  title: z.string().trim().min(1, "Title is required").max(MAX_TITLE_LENGTH),
});

/**
 * Every field optional — this is what autosave calls, and it sends only what
 * changed. `.strict()` rejects unknown keys so a client cannot smuggle in
 * workspace_id or created_by.
 */
export const updateNoteSchema = z
  .object({
    assigneeId: z.uuid().nullable().optional(),
    body: bodySchema.optional(),
    dueDate: z.iso.date().nullable().optional(),
    status: z.enum(NOTE_STATUSES).optional(),
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH).optional(),
  })
  .strict()
  .refine((values) => Object.keys(values).length > 0, {
    message: "Nothing to update",
  });

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
