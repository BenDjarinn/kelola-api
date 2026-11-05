import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db/index.js";
import { workspaceMembers, workspaces } from "../db/schema.js";
import { env } from "../env.js";

export const DEFAULT_MEMBER_ROLE = "member";

/**
 * Adds a user to the configured default workspace.
 *
 * Without this a new registration lands in an empty app with no way out, because
 * workspace creation does not exist yet — signing up is currently a dead end.
 *
 * Returns the workspace id when a membership was added or already existed, and
 * null when no default workspace is configured or found.
 *
 * Never throws. This runs inside the sign-up flow, and failing to join a demo
 * workspace must not stop someone creating an account.
 */
export async function joinDefaultWorkspace(userId: string): Promise<string | null> {
  const slug = env.DEFAULT_WORKSPACE_SLUG;

  if (!slug) {
    return null;
  }

  try {
    const [workspace] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.slug, slug), isNull(workspaces.deletedAt)))
      .limit(1);

    if (!workspace) {
      console.warn(`DEFAULT_WORKSPACE_SLUG "${slug}" does not match any workspace`);
      return null;
    }

    const [existing] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, userId),
          isNull(workspaceMembers.deletedAt),
        ),
      )
      .limit(1);

    if (existing) {
      return workspace.id;
    }

    await db.insert(workspaceMembers).values({
      role: DEFAULT_MEMBER_ROLE,
      userId,
      workspaceId: workspace.id,
    });

    return workspace.id;
  } catch (error) {
    console.error("Could not join the default workspace", error);

    return null;
  }
}
