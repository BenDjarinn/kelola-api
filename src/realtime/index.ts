import { fromNodeHeaders } from "better-auth/node";
import { Server } from "socket.io";

import { corsOrigins } from "../env.js";
import { auth } from "../lib/auth.js";
import { registerDiscussionHandlers } from "./discussion.handlers.js";

import type { Server as HttpServer } from "node:http";

export interface SocketUser {
  id: string;
  name: string;
}

declare module "socket.io" {
  interface Socket {
    user?: SocketUser;
  }
}

export function projectRoom(projectId: string): string {
  return `project:${projectId}`;
}

export function createRealtimeServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      // Must mirror the Express CORS config — the handshake is a browser request
      // and needs the cookie, so credentials cannot be omitted.
      credentials: true,
      origin: corsOrigins,
    },
  });

  /**
   * Authenticate at the handshake rather than per event.
   *
   * Reuses the same Better Auth session the REST routes use, including the
   * soft-delete check — without it a deleted user keeps a working socket until
   * their session expires.
   */
  io.use(async (socket, next) => {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(socket.request.headers),
      });

      if (!session || session.user.deletedAt) {
        next(new Error("Unauthorized"));
        return;
      }

      socket.user = { id: session.user.id, name: session.user.name };

      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    registerDiscussionHandlers(io, socket);
  });

  return io;
}
