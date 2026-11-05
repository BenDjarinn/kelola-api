import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import express from "express";

import { corsOrigins, env } from "./env.js";
import { auth } from "./lib/auth.js";
import { requireAuth } from "./middleware/auth.js";
import { aiRouter } from "./routes/ai.js";
import { messagesRouter } from "./routes/messages.js";
import { notesRouter } from "./routes/notes.js";
import { projectsRouter } from "./routes/projects.js";

import type { Express, NextFunction, Request, Response } from "express";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");

  // credentials: true is required for the session cookie to cross origins.
  app.use(
    cors({
      credentials: true,
      origin: corsOrigins,
    }),
  );

  // Mounted BEFORE express.json(): Better Auth reads the raw request body itself,
  // and if express.json() consumes the stream first every auth request hangs.
  // "/api/auth/*splat" is Express 5 wildcard syntax — a bare "*" no longer parses.
  app.all("/api/auth/*splat", toNodeHandler(auth));

  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  // Confirms the session cookie round-trips. Better Auth already exposes
  // /api/auth/get-session; this proves requireAuth itself works.
  app.get("/api/me", requireAuth, (request, response) => {
    response.json({ user: request.user });
  });

  app.use("/api/ai", aiRouter);
  app.use("/api/messages", messagesRouter);
  app.use("/api/notes", notesRouter);
  app.use("/api/projects", projectsRouter);

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error("Unhandled error", error);

    const message = env.NODE_ENV === "production" ? "Internal server error" : String(error);

    response.status(500).json({ error: message });
  });

  return app;
}
