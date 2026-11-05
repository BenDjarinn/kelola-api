import { describe, expect, it } from "vitest";

import {
  buildConversationContext,
  fromGeminiRole,
  isRetryableError,
  toGeminiRole,
} from "./ai.service.js";

import type { ConversationTurn } from "./ai.service.js";
import type { Part } from "@google/genai";

describe("role mapping", () => {
  it("maps our roles to Gemini's", () => {
    expect(toGeminiRole("user")).toBe("user");
    expect(toGeminiRole("assistant")).toBe("model");
  });

  it("maps Gemini's roles back to ours", () => {
    expect(fromGeminiRole("user")).toBe("user");
    expect(fromGeminiRole("model")).toBe("assistant");
  });

  it("round-trips without drifting", () => {
    // A wrong role does not throw, it silently tells the model the user said what
    // it said — so this is checked explicitly rather than trusted.
    for (const role of ["user", "assistant"] as const) {
      expect(fromGeminiRole(toGeminiRole(role))).toBe(role);
    }
  });
});

describe("buildConversationContext", () => {
  const turns: ConversationTurn[] = [
    { content: "first", role: "user" },
    { content: "second", role: "assistant" },
    { content: "third", role: "user" },
    { content: "fourth", role: "assistant" },
    { content: "fifth", role: "user" },
  ];

  it("keeps only the most recent turns", () => {
    const context = buildConversationContext(turns, 3);

    expect(context).toHaveLength(3);
    expect(context.map((entry) => entry.parts[0]?.text)).toEqual(["third", "fourth", "fifth"]);
  });

  it("preserves chronological order", () => {
    const context = buildConversationContext(turns, 5);

    expect(context.map((entry) => entry.parts[0]?.text)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
      "fifth",
    ]);
  });

  it("converts roles on the way out", () => {
    const context = buildConversationContext(turns, 2);

    expect(context.map((entry) => entry.role)).toEqual(["model", "user"]);
  });

  it("returns everything when fewer turns than the limit", () => {
    expect(buildConversationContext(turns.slice(0, 2), 20)).toHaveLength(2);
  });

  it("returns nothing for an empty conversation", () => {
    expect(buildConversationContext([], 20)).toEqual([]);
  });

  it("adds attachments to the current user turn before its prompt", () => {
    const attachmentParts: Part[] = [
      { text: "Attached file follows." },
      { inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } },
    ];

    const context = buildConversationContext(turns, 3, attachmentParts);
    const currentParts = context.at(-1)?.parts;

    expect(currentParts).toEqual([...attachmentParts, { text: "fifth" }]);
    expect(context.at(-2)?.parts).toEqual([{ text: "fourth" }]);
  });
});

describe("isRetryableError", () => {
  it("retries transient Google failures", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(isRetryableError({ status })).toBe(true);
    }
  });

  it("does not retry errors that will not change", () => {
    // 400 is a bad key or bad model id — retrying only delays the real error.
    for (const status of [400, 401, 403, 404]) {
      expect(isRetryableError({ status })).toBe(false);
    }
  });

  it("does not retry errors with no status", () => {
    expect(isRetryableError(new Error("socket hang up"))).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});
