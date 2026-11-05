import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db/index.js";
import { projects, workspaceMembers } from "../db/schema.js";

export interface AccessibleProject {
  id: string;
  name: string;
  workspaceId: string;
}

export class ProjectAccessError extends Error {
  readonly status: 403 | 404;

  constructor(message: string, status: 403 | 404) {
    super(message);
    this.name = "ProjectAccessError";
    this.status = status;
  }
}

/**
 * Resolves a project the user is allowed to use, or throws.
 *
 * Returns `workspaceId` from the project row so callers never take it from the
 * request body — a caller-supplied workspace id would let someone write messages
 * into another tenant's workspace.
 *
 * 404 for both "missing" and "soft-deleted"; 403 only once we know the project
 * exists and the user simply is not a member.
 */
export async function assertProjectAccess(
  userId: string,
  projectId: string,
): Promise<AccessibleProject> {
  const [project] = await db
    .select({
      id: projects.id,
      name: projects.name,
      workspaceId: projects.workspaceId,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);

  if (!project) {
    throw new ProjectAccessError("Project not found", 404);
  }

  const [membership] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, project.workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.deletedAt),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new ProjectAccessError("You do not have access to this project", 403);
  }

  return project;
}
