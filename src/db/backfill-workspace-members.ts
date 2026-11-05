import { and, eq, isNull, notExists } from "drizzle-orm";

import { closeDatabase, db } from "./index.js";
import { users, workspaceMembers, workspaces } from "./schema.js";

/**
 * Adds every existing active user to a workspace they are not yet a member of.
 *
 * Needed because DEFAULT_WORKSPACE_SLUG is not retroactive: auto-join runs in Better
 * Auth's `user.create.after` hook, so it only ever fires during registration. Every
 * account created before that variable was set — or before the workspace existed —
 * is left without a membership and sees an empty app with no way out, since there is
 * still no UI for creating or joining a workspace.
 *
 * Idempotent, and safe to re-run: the partial unique index
 * `workspace_members_active_unique` already forbids a second live membership, and
 * the NOT EXISTS below skips anyone who has one rather than relying on a conflict.
 *
 * Grants `member`, never `owner`: the workspace owner is whoever seed.ts recorded,
 * and silently promoting everyone would be a different decision than the one asked
 * for here.
 *
 *   npm run db:backfill-members              -> kelola-demo
 *   npm run db:backfill-members other-slug   -> that workspace
 */
const DEFAULT_SLUG = "kelola-demo";

async function backfill(): Promise<void> {
  const slug = process.argv[2] ?? DEFAULT_SLUG;

  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(and(eq(workspaces.slug, slug), isNull(workspaces.deletedAt)))
    .limit(1);

  if (!workspace) {
    throw new Error(
      `No active workspace with slug "${slug}". Run npm run db:seed first, or pass the right slug.`,
    );
  }

  const unjoined = await db
    .select({ email: users.email, id: users.id })
    .from(users)
    .where(
      and(
        isNull(users.deletedAt),
        notExists(
          db
            .select({ id: workspaceMembers.id })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspaceId, workspace.id),
                eq(workspaceMembers.userId, users.id),
                isNull(workspaceMembers.deletedAt),
              ),
            ),
        ),
      ),
    );

  if (unjoined.length === 0) {
    console.log(`Every active user is already a member of "${workspace.name}". Nothing to do.`);
    return;
  }

  await db.insert(workspaceMembers).values(
    unjoined.map((user) => ({
      role: "member",
      userId: user.id,
      workspaceId: workspace.id,
    })),
  );

  console.log(`Added ${unjoined.length} member(s) to "${workspace.name}":`);
  for (const user of unjoined) {
    console.log(`  - ${user.email}`);
  }
}

backfill()
  .then(async () => {
    await closeDatabase();
  })
  .catch(async (error: unknown) => {
    console.error("Backfill failed", error);
    await closeDatabase();
    process.exit(1);
  });
