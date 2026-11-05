import { GoogleGenAI } from "@google/genai";

import { env } from "../env.js";

import type { Part } from "@google/genai";

export type AiMessageRole = "user" | "assistant";
export type GeminiRole = "user" | "model";

export interface ConversationTurn {
  content: string;
  role: AiMessageRole;
}

export interface GeminiContent {
  parts: Part[];
  role: GeminiRole;
}

/**
 * Four attempts with ~1s/2s/4s backoff rather than the original 3 at 0.5s/1s.
 * Gemini's 503 is "this model is experiencing high demand", which routinely lasts
 * longer than a second and a half — the short schedule gave up while the model was
 * still only briefly busy.
 */
const MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 1000;
/** Transient on Google's side — worth retrying. Anything else is not. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Asserted on import rather than on first chat request: this module is reached
 * from app.ts, so a missing key stops the server at boot instead of surfacing as
 * a 502 the first time a user sends a message. Database tooling never imports
 * this file, so migrations and seeds run without a key.
 */
if (!env.GEMINI_API_KEY) {
  throw new Error(
    "GEMINI_API_KEY is required to serve the AI routes. Add it to kelola-api/.env.local — get one at https://aistudio.google.com/apikey",
  );
}

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

/**
 * Gemini names the assistant "model"; the ERD stores "assistant". Converting in
 * one place matters because a wrong role does not throw — it silently tells the
 * model the user said what it said, which corrupts the whole conversation.
 */
export function toGeminiRole(role: AiMessageRole): GeminiRole {
  return role === "assistant" ? "model" : "user";
}

export function fromGeminiRole(role: GeminiRole): AiMessageRole {
  return role === "model" ? "assistant" : "user";
}

/**
 * Takes the most recent turns, keeping chronological order. Expects `turns`
 * oldest-first and returns the tail, so the model always sees the newest context.
 */
export function buildConversationContext(
  turns: readonly ConversationTurn[],
  maxTurns: number = env.AI_CONTEXT_MESSAGE_COUNT,
  currentAttachmentParts: readonly Part[] = [],
): GeminiContent[] {
  const recentTurns = maxTurns > 0 ? turns.slice(-maxTurns) : [];

  return recentTurns.map((turn, index) => {
    const isCurrentUserTurn = index === recentTurns.length - 1 && turn.role === "user";

    return {
      // Media precedes the question so Gemini reads the attachment as source
      // material and then receives the user's instruction as the final part.
      parts:
        isCurrentUserTurn && currentAttachmentParts.length > 0
          ? [...currentAttachmentParts, { text: turn.content }]
          : [{ text: turn.content }],
      role: toGeminiRole(turn.role),
    };
  });
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const { status } = error as { status?: unknown };

  return typeof status === "number" ? status : undefined;
}

export function isRetryableError(error: unknown): boolean {
  const status = getStatusCode(error);

  return status === undefined ? false : RETRYABLE_STATUS_CODES.has(status);
}

async function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class AiGenerationError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status: number | undefined) {
    super(message);
    this.name = "AiGenerationError";
    this.status = status;
  }
}

/**
 * Sends the conversation to Gemini and returns the reply text.
 *
 * Retries only transient failures, with exponential backoff. A 400 (bad key, bad
 * model id) is returned immediately — retrying it just delays the error.
 */
async function generateWithModel(contents: GeminiContent[], model: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        contents,
        model,
      });

      const text = response.text?.trim();

      if (!text) {
        // A blocked or empty completion is not an exception from the SDK, but it
        // is useless to the caller — treat it as a failure rather than storing "".
        throw new AiGenerationError("Gemini returned an empty response", undefined);
      }

      return text;
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error) || attempt === MAX_ATTEMPTS) {
        break;
      }

      await delay(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  if (lastError instanceof AiGenerationError) {
    throw lastError;
  }

  const status = getStatusCode(lastError);
  const message = lastError instanceof Error ? lastError.message : "Unknown Gemini error";

  throw new AiGenerationError(message, status);
}

/**
 * Sends the conversation to Gemini and returns the reply text.
 *
 * Falls back to a second model when the primary is overloaded. Google's capacity
 * varies per model: on 2026-11-05 gemini-3.6-flash returned 503 while
 * gemini-3.5-flash-lite answered normally, so a fallback turns a user-visible
 * failure into a slightly lower-quality answer.
 *
 * Only retryable statuses trigger the fallback — a bad key or bad request would
 * fail identically on the second model.
 */
export async function generateAiReply(contents: GeminiContent[]): Promise<string> {
  try {
    return await generateWithModel(contents, env.GEMINI_MODEL);
  } catch (error) {
    const shouldTryFallback =
      env.GEMINI_FALLBACK_MODEL !== env.GEMINI_MODEL &&
      error instanceof AiGenerationError &&
      error.status !== undefined &&
      RETRYABLE_STATUS_CODES.has(error.status);

    if (!shouldTryFallback) {
      throw error;
    }

    console.warn(
      `Gemini model ${env.GEMINI_MODEL} unavailable, falling back to ${env.GEMINI_FALLBACK_MODEL}`,
    );

    return generateWithModel(contents, env.GEMINI_FALLBACK_MODEL);
  }
}
