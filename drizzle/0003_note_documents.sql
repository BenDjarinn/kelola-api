CREATE TYPE "public"."note_status" AS ENUM('open', 'in_progress', 'done');--> statement-breakpoint
CREATE TABLE "note_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"assignee_id" uuid,
	"status" "note_status" DEFAULT 'open' NOT NULL,
	"due_date" date,
	"body" jsonb,
	"created_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_documents" ADD CONSTRAINT "note_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_documents" ADD CONSTRAINT "note_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_documents" ADD CONSTRAINT "note_documents_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_documents" ADD CONSTRAINT "note_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_documents_project_updated_idx" ON "note_documents" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "note_documents_assignee_idx" ON "note_documents" USING btree ("assignee_id");