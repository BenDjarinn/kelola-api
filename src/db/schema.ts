import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Auth tables are owned by Better Auth.
 *
 * Drizzle property names (camelCase) are what Better Auth reads; the string passed
 * to each column is the snake_case name Postgres sees, so the database stays
 * consistent with the rest of the ERD. Do not rename a property without checking
 * Better Auth's expected field names.
 */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    // Better Auth calls this `image`; the ERD calls the column avatar_url.
    image: text("avatar_url"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Partial unique index: the database permits reusing the email of a
    // soft-deleted user.
    //
    // NOTE (verified by test): this alone does NOT enable re-registration. Better
    // Auth looks up the email before inserting and does not filter on deleted_at,
    // so sign-up still returns USER_ALREADY_EXISTS. To actually free an address,
    // anonymise it when soft-deleting (e.g. set email to
    // `deleted+<id>@invalid`). Left partial so that change needs no migration.
    uniqueIndex("users_email_active_unique")
      .on(table.email)
      .where(sql`${table.deletedAt} is null`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("sessions_token_unique").on(table.token),
    index("sessions_user_id_idx").on(table.userId),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Provider's own id for the user. For credentials this is the user id. */
    accountId: text("account_id").notNull(),
    /** "credential" for email+password, otherwise the social provider id. */
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    /** Password hash for the credential provider. Never on the users row. */
    password: text("password"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("accounts_provider_account_unique").on(table.providerId, table.accountId),
    index("accounts_user_id_idx").on(table.userId),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

/**
 * Workspace domain tables, following the ERD.
 *
 * Vocabulary reminder: a workspace is a Discord-style server, a channel is a
 * channel *type* within it, and a "project" is a sub-room inside a channel — not
 * project management.
 */

export const channelTypeEnum = pgEnum("channel_type", ["discussion", "notes", "ai"]);

export const aiMessageRoleEnum = pgEnum("ai_message_role", ["user", "assistant"]);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    iconUrl: text("icon_url"),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Partial, so a soft-deleted workspace does not keep its slug reserved.
    uniqueIndex("workspaces_slug_active_unique")
      .on(table.slug)
      .where(sql`${table.deletedAt} is null`),
    index("workspaces_owner_id_idx").on(table.ownerId),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // One live membership per user per workspace; re-joining after removal is allowed.
    uniqueIndex("workspace_members_active_unique")
      .on(table.workspaceId, table.userId)
      .where(sql`${table.deletedAt} is null`),
    index("workspace_members_user_id_idx").on(table.userId),
  ],
);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: channelTypeEnum("type").notNull(),
    config: jsonb("config"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("channels_workspace_id_idx").on(table.workspaceId)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    // Denormalised from the channel so tenant scoping is one WHERE, not a join.
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    picUserId: uuid("pic_user_id").references(() => users.id),
    meetingLink: text("meeting_link"),
    metadata: jsonb("metadata"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("projects_channel_id_idx").on(table.channelId),
    index("projects_workspace_id_idx").on(table.workspaceId),
  ],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Null for assistant replies — those are authored by Gemini, not a person. */
    userId: uuid("user_id").references(() => users.id),
    role: aiMessageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Every history read filters by project and orders by time — exactly this index.
    index("ai_messages_project_created_idx").on(table.projectId, table.createdAt),
    // Supports the per-user daily rate-limit count.
    index("ai_messages_user_created_idx").on(table.userId, table.createdAt),
  ],
);

/**
 * Discussion channel messages. Unlike ai_messages, every row has a human author,
 * so user_id is not null.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    content: text("content").notNull(),
    /** In the ERD for future attachments; unused until file upload is built. */
    fileUri: text("file_uri"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Every history read filters by project and orders by time.
    index("messages_project_created_idx").on(table.projectId, table.createdAt),
    index("messages_user_id_idx").on(table.userId),
  ],
);

/**
 * Meeting notes. Per the ERD this is a Notion-style database row rather than a
 * plain document: properties (assignee, status, due date) plus a block-based body.
 */
export const noteStatusEnum = pgEnum("note_status", ["open", "in_progress", "done"]);

export const noteDocuments = pgTable(
  "note_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Nullable: a note does not have to be assigned to anyone. */
    assigneeId: uuid("assignee_id").references(() => users.id),
    // An enum rather than the ERD's loose string: a typo in a status is otherwise
    // invisible until it quietly breaks a filter.
    status: noteStatusEnum("status").notNull().default("open"),
    dueDate: date("due_date"),
    /** BlockNote document array. Shape is the editor's concern, not the schema's. */
    body: jsonb("body"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Listed by most recently edited, not created — so the index matches the sort.
    index("note_documents_project_updated_idx").on(table.projectId, table.updatedAt),
    index("note_documents_assignee_idx").on(table.assigneeId),
  ],
);
