import { describe, expect, it } from "vitest";
import { z } from "zod";

import { canModifyMessage, MAX_MESSAGE_LENGTH } from "./discussion.service.js";

const AUTHOR = "11111111-1111-4111-8111-111111111111";
const SOMEONE_ELSE = "22222222-2222-4222-8222-222222222222";

describe("canModifyMessage", () => {
  it("lets the author change their own message", () => {
    expect(canModifyMessage(AUTHOR, AUTHOR)).toBe(true);
  });

  it("refuses anyone else", () => {
    // Guards the rule that matters most here: in a shared channel every other
    // member can see a message, and none of them may edit or delete it.
    expect(canModifyMessage(AUTHOR, SOMEONE_ELSE)).toBe(false);
  });
});

/**
 * Mirrors the payload schema in src/realtime/discussion.handlers.ts. Socket
 * handlers cannot reject bad input the way an HTTP layer would, so the validation
 * rules are worth pinning down.
 */
const sendPayloadSchema = z.object({
  content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  projectId: z.uuid(),
});

describe("message payload validation", () => {
  const validProjectId = "33333333-3333-4333-8333-333333333333";

  it("accepts a normal message", () => {
    expect(sendPayloadSchema.safeParse({ content: "halo", projectId: validProjectId }).success).toBe(
      true,
    );
  });

  it("rejects an empty message", () => {
    expect(sendPayloadSchema.safeParse({ content: "", projectId: validProjectId }).success).toBe(
      false,
    );
  });

  it("rejects whitespace masquerading as content", () => {
    expect(
      sendPayloadSchema.safeParse({ content: "   \n  ", projectId: validProjectId }).success,
    ).toBe(false);
  });

  it("accepts a message exactly on the length limit", () => {
    const content = "a".repeat(MAX_MESSAGE_LENGTH);

    expect(sendPayloadSchema.safeParse({ content, projectId: validProjectId }).success).toBe(true);
  });

  it("rejects a message one character over the limit", () => {
    const content = "a".repeat(MAX_MESSAGE_LENGTH + 1);

    expect(sendPayloadSchema.safeParse({ content, projectId: validProjectId }).success).toBe(false);
  });

  it("rejects a projectId that is not a UUID", () => {
    expect(sendPayloadSchema.safeParse({ content: "halo", projectId: "nope" }).success).toBe(false);
  });
});
