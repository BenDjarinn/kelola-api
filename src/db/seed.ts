import { and, eq, isNull } from "drizzle-orm";

import { closeDatabase, db } from "./index.js";
import { channels, projects, users, workspaceMembers, workspaces } from "./schema.js";

/**
 * Creates one workspace, one AI channel and one project for an existing user.
 *
 * Needed because workspace/channel/project CRUD endpoints do not exist yet, so
 * there is otherwise no way to obtain a valid project_id for the AI endpoints.
 *
 * Idempotent: looks up by slug first, so re-running is safe.
 *
 *   npm run db:seed              -> uses the oldest user
 *   npm run db:seed you@mail.com -> uses that user
 */
const WORKSPACE_SLUG = "kelola-demo";

async function seed(): Promise<void> {
  const requestedEmail = process.argv[2];

  const [owner] = requestedEmail
    ? await db
        .select({ email: users.email, id: users.id })
        .from(users)
        .where(and(eq(users.email, requestedEmail), isNull(users.deletedAt)))
        .limit(1)
    : await db
        .select({ email: users.email, id: users.id })
        .from(users)
        .where(isNull(users.deletedAt))
        .orderBy(users.createdAt)
        .limit(1);

  if (!owner) {
    throw new Error(
      requestedEmail
        ? `No active user with email ${requestedEmail}. Sign up first.`
        : "No users found. Sign up at http://localhost:3000/sign-up first.",
    );
  }

  const [existingWorkspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.slug, WORKSPACE_SLUG), isNull(workspaces.deletedAt)))
    .limit(1);

  const workspaceId =
    existingWorkspace?.id ??
    (
      await db
        .insert(workspaces)
        .values({
          description: "Seeded workspace for local development",
          name: "Kelola Demo",
          ownerId: owner.id,
          slug: WORKSPACE_SLUG,
        })
        .returning({ id: workspaces.id })
    )[0]!.id;

  const [existingMembership] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, owner.id),
        isNull(workspaceMembers.deletedAt),
      ),
    )
    .limit(1);

  if (!existingMembership) {
    await db.insert(workspaceMembers).values({
      role: "owner",
      userId: owner.id,
      workspaceId,
    });
  }

  const [existingChannel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.type, "ai"),
        isNull(channels.deletedAt),
      ),
    )
    .limit(1);

  const channelId =
    existingChannel?.id ??
    (
      await db
        .insert(channels)
        .values({
          createdBy: owner.id,
          name: "Kelola AI",
          type: "ai",
          workspaceId,
        })
        .returning({ id: channels.id })
    )[0]!.id;

  const [existingProject] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.channelId, channelId), isNull(projects.deletedAt)))
    .limit(1);

  const projectId =
    existingProject?.id ??
    (
      await db
        .insert(projects)
        .values({
          channelId,
          createdBy: owner.id,
          name: "Website Discussion Update",
          picUserId: owner.id,
          workspaceId,
        })
        .returning({ id: projects.id })
    )[0]!.id;

  const [existingDiscussionChannel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.type, "discussion"),
        isNull(channels.deletedAt),
      ),
    )
    .limit(1);

  const discussionChannelId =
    existingDiscussionChannel?.id ??
    (
      await db
        .insert(channels)
        .values({
          createdBy: owner.id,
          name: "development-discussion",
          type: "discussion",
          workspaceId,
        })
        .returning({ id: channels.id })
    )[0]!.id;

  const [existingDiscussionProject] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.channelId, discussionChannelId), isNull(projects.deletedAt)))
    .limit(1);

  const discussionProjectId =
    existingDiscussionProject?.id ??
    (
      await db
        .insert(projects)
        .values({
          channelId: discussionChannelId,
          createdBy: owner.id,
          name: "Sprint Planning",
          picUserId: owner.id,
          workspaceId,
        })
        .returning({ id: projects.id })
    )[0]!.id;

  const [existingNotesChannel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.type, "notes"),
        isNull(channels.deletedAt),
      ),
    )
    .limit(1);

  const notesChannelId =
    existingNotesChannel?.id ??
    (
      await db
        .insert(channels)
        .values({
          createdBy: owner.id,
          name: "meeting-notes",
          type: "notes",
          workspaceId,
        })
        .returning({ id: channels.id })
    )[0]!.id;

  const [existingNotesProject] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.channelId, notesChannelId), isNull(projects.deletedAt)))
    .limit(1);

  const notesProjectId =
    existingNotesProject?.id ??
    (
      await db
        .insert(projects)
        .values({
          channelId: notesChannelId,
          createdBy: owner.id,
          name: "Weekly Standup",
          picUserId: owner.id,
          workspaceId,
        })
        .returning({ id: projects.id })
    )[0]!.id;

  console.log("Seed complete.");
  console.log(`  owner       ${owner.email}`);
  console.log(`  workspaceId ${workspaceId}`);
  console.log(`  channelId   ${channelId}`);
  console.log(`  AI project         ${projectId}`);
  console.log(`  Discussion project ${discussionProjectId}`);
  console.log(`  Notes project      ${notesProjectId}`);
}

try {
  await seed();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
