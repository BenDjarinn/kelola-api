import { z } from "zod";

import {
  createMessage,
  deleteMessage,
  editMessage,
  MAX_MESSAGE_LENGTH,
  MessageAccessError,
} from "../services/discussion.service.js";
import { assertProjectAccess, ProjectAccessError } from "../services/project-access.service.js";
import { projectRoom } from "./index.js";

import type { Server, Socket } from "socket.io";

const projectPayloadSchema = z.object({
  projectId: z.uuid(),
});

const sendPayloadSchema = z.object({
  content: z.string().trim().min(1, "Message cannot be empty").max(MAX_MESSAGE_LENGTH),
  projectId: z.uuid(),
});

const editPayloadSchema = z.object({
  content: z.string().trim().min(1, "Message cannot be empty").max(MAX_MESSAGE_LENGTH),
  messageId: z.uuid(),
  projectId: z.uuid(),
});

const deletePayloadSchema = z.object({
  messageId: z.uuid(),
  projectId: z.uuid(),
});

function emitError(socket: Socket, message: string): void {
  socket.emit("error", { message });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof ProjectAccessError || error instanceof MessageAccessError) {
    return error.message;
  }

  console.error("Discussion socket error", error);

  return "Something went wrong";
}

export function registerDiscussionHandlers(io: Server, socket: Socket): void {
  const user = socket.user!;

  /**
   * Access is re-checked on every event, not only at join.
   *
   * A socket stays connected after its owner is removed from the workspace, so a
   * join-time-only check would let a removed member keep posting for as long as
   * they hold the connection open.
   */
  async function requireProjectAccess(projectId: string) {
    return assertProjectAccess(user.id, projectId);
  }

  socket.on("project:join", async (payload: unknown) => {
    try {
      const { projectId } = projectPayloadSchema.parse(payload);

      await requireProjectAccess(projectId);
      await socket.join(projectRoom(projectId));

      socket.emit("project:joined", { projectId });
    } catch (error) {
      emitError(socket, toErrorMessage(error));
    }
  });

  socket.on("project:leave", async (payload: unknown) => {
    try {
      const { projectId } = projectPayloadSchema.parse(payload);

      await socket.leave(projectRoom(projectId));
    } catch (error) {
      emitError(socket, toErrorMessage(error));
    }
  });

  socket.on("message:send", async (payload: unknown) => {
    try {
      const { content, projectId } = sendPayloadSchema.parse(payload);

      // workspaceId comes from the project row, never the payload — otherwise a
      // caller could write into another tenant's workspace.
      const project = await requireProjectAccess(projectId);

      const message = await createMessage({
        content,
        projectId: project.id,
        userId: user.id,
        workspaceId: project.workspaceId,
      });

      // Includes the sender: the client reconciles its optimistic copy by id.
      io.to(projectRoom(projectId)).emit("message:new", { message, projectId });
    } catch (error) {
      emitError(socket, toErrorMessage(error));
    }
  });

  socket.on("message:edit", async (payload: unknown) => {
    try {
      const { content, messageId, projectId } = editPayloadSchema.parse(payload);

      await requireProjectAccess(projectId);

      const message = await editMessage({ content, messageId, userId: user.id });

      io.to(projectRoom(projectId)).emit("message:updated", { message, projectId });
    } catch (error) {
      emitError(socket, toErrorMessage(error));
    }
  });

  socket.on("message:delete", async (payload: unknown) => {
    try {
      const { messageId, projectId } = deletePayloadSchema.parse(payload);

      await requireProjectAccess(projectId);

      const deleted = await deleteMessage({ messageId, userId: user.id });

      io.to(projectRoom(projectId)).emit("message:deleted", {
        messageId: deleted.messageId,
        projectId,
      });
    } catch (error) {
      emitError(socket, toErrorMessage(error));
    }
  });

  for (const [event, isTyping] of [
    ["typing:start", true],
    ["typing:stop", false],
  ] as const) {
    socket.on(event, async (payload: unknown) => {
      try {
        const { projectId } = projectPayloadSchema.parse(payload);

        // Not persisted: typing is ephemeral UI state. Broadcast excludes the
        // sender, who does not need to be told they are typing.
        socket.to(projectRoom(projectId)).emit("typing", {
          isTyping,
          projectId,
          userId: user.id,
          userName: user.name,
        });
      } catch {
        // A malformed typing payload is not worth surfacing to the user.
      }
    });
  }
}
