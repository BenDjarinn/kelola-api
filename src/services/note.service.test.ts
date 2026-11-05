import { describe, expect, it } from "vitest";

import {
  createNoteSchema,
  isBodyWithinLimit,
  MAX_BODY_BYTES,
  MAX_TITLE_LENGTH,
  updateNoteSchema,
} from "./note.service.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

describe("createNoteSchema", () => {
  it("accepts a normal title", () => {
    expect(createNoteSchema.safeParse({ projectId: PROJECT_ID, title: "Notulen" }).success).toBe(
      true,
    );
  });

  it("rejects an empty or whitespace-only title", () => {
    expect(createNoteSchema.safeParse({ projectId: PROJECT_ID, title: "" }).success).toBe(false);
    expect(createNoteSchema.safeParse({ projectId: PROJECT_ID, title: "   " }).success).toBe(false);
  });

  it("rejects a title one character over the limit", () => {
    const title = "a".repeat(MAX_TITLE_LENGTH + 1);

    expect(createNoteSchema.safeParse({ projectId: PROJECT_ID, title }).success).toBe(false);
  });
});

describe("updateNoteSchema", () => {
  it("accepts a single changed field, which is what autosave sends", () => {
    expect(updateNoteSchema.safeParse({ title: "Judul baru" }).success).toBe(true);
    expect(updateNoteSchema.safeParse({ status: "done" }).success).toBe(true);
  });

  it("allows clearing the assignee and due date", () => {
    expect(updateNoteSchema.safeParse({ assigneeId: null, dueDate: null }).success).toBe(true);
  });

  it("rejects an empty patch", () => {
    expect(updateNoteSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(updateNoteSchema.safeParse({ status: "arsip" }).success).toBe(false);
  });

  it("rejects fields a client must never set", () => {
    // .strict() is what stops a caller smuggling in workspace_id or created_by and
    // moving a note into another tenant.
    expect(updateNoteSchema.safeParse({ title: "x", workspaceId: USER_ID }).success).toBe(false);
    expect(updateNoteSchema.safeParse({ createdBy: USER_ID, title: "x" }).success).toBe(false);
  });

  it("rejects a body over the size cap", () => {
    const huge = [{ text: "a".repeat(MAX_BODY_BYTES + 100) }];

    expect(updateNoteSchema.safeParse({ body: huge }).success).toBe(false);
  });
});

describe("isBodyWithinLimit", () => {
  it("treats an absent body as fine", () => {
    expect(isBodyWithinLimit(undefined)).toBe(true);
    expect(isBodyWithinLimit(null)).toBe(true);
  });

  it("accepts a realistic note", () => {
    expect(isBodyWithinLimit([{ content: "Follow up ke Albert", type: "paragraph" }])).toBe(true);
  });

  it("rejects something unserialisable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(isBodyWithinLimit(circular)).toBe(false);
  });
});
