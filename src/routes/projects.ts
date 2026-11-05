import { and, asc, eq, isNull } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { db } from "../db/index.js";
import { channels, projects, users, workspaceMembers } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { assertProjectAccess, ProjectAccessError } from "../services/project-access.service.js";

export const projectsRouter = Router();

projectsRouter.use(requireAuth);

/**
 * Projects the signed-in user can open, across every channel type.
 *
 * Read-only and deliberately minimal — full project CRUD is still steps 6–7 of the
 * build plan. This exists because the frontend previously listed hardcoded projects
 * with slug ids ("website-discussion-update") that do not exist in the database,
 * so there was no way to reach a real project id from the UI.
 *
 * Scoped by workspace membership, so one user never sees another tenant's projects.
 *
 * `?type=` narrows to one channel type. Without it this returned AI projects only,
 * which left the Discussion channel with no reachable project id.
 */
const projectsQuerySchema = z.object({
  type: z.enum(["discussion", "notes", "ai"]).optional(),
});

projectsRouter.get("/", async (request, response, next) => {
  try {
    const userId = request.user!.id;

    const parsedQuery = projectsQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      response.status(400).json({ error: "type must be discussion, notes or ai" });
      return;
    }

    const { type } = parsedQuery.data;

    const rows = await db
      .select({
        channelId: projects.channelId,
        channelType: channels.type,
        createdAt: projects.createdAt,
        id: projects.id,
        meetingLink: projects.meetingLink,
        name: projects.name,
        picName: users.name,
        workspaceId: projects.workspaceId,
      })
      .from(projects)
      .innerJoin(channels, eq(channels.id, projects.channelId))
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, projects.workspaceId))
      .leftJoin(users, eq(users.id, projects.picUserId))
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          isNull(workspaceMembers.deletedAt),
          ...(type ? [eq(channels.type, type)] : []),
          isNull(channels.deletedAt),
          isNull(projects.deletedAt),
        ),
      )
      .orderBy(asc(projects.createdAt));

    response.json({ projects: rows });
  } catch (error) {
    next(error);
  }
});

/**
 * People in this project's workspace, for assignee pickers.
 *
 * Scoped by project rather than workspace so it can reuse assertProjectAccess and
 * inherit its 403/404 behaviour — no second copy of the membership rules.
 */
projectsRouter.get("/:projectId/members", async (request, response, next) => {
  try {
    const userId = request.user!.id;
    const projectId = request.params.projectId;

    if (!z.uuid().safeParse(projectId).success) {
      response.status(400).json({ error: "projectId must be a UUID" });
      return;
    }

    const project = await assertProjectAccess(userId, projectId);

    const rows = await db
      .select({
        avatarUrl: users.image,
        email: users.email,
        id: users.id,
        name: users.name,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, project.workspaceId),
          isNull(workspaceMembers.deletedAt),
          isNull(users.deletedAt),
        ),
      )
      .orderBy(asc(users.name));

    response.json({ members: rows });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      response.status(error.status).json({ error: error.message });
      return;
    }

    next(error);
  }
});
