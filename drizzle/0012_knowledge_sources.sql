CREATE TYPE "public"."pipeline_run_kind" AS ENUM('facts', 'playbook');--> statement-breakpoint
CREATE TYPE "public"."pipeline_run_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."playbook_suggestion_kind" AS ENUM('goal', 'field', 'objection', 'limit', 'tone', 'never', 'discovery_question');--> statement-breakpoint
CREATE TYPE "public"."playbook_suggestion_status" AS ENUM('suggested', 'accepted', 'edited', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('website', 'file', 'text', 'call');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('processing', 'ready', 'needs_input', 'partly_failed', 'failed');--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "pipeline_run_kind" NOT NULL,
	"status" "pipeline_run_status" DEFAULT 'queued' NOT NULL,
	"model" text,
	"source_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"input_hash" text,
	"usage" jsonb,
	"cost_estimate_micros" bigint,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbook_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" "playbook_suggestion_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "playbook_suggestion_status" DEFAULT 'suggested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"locator" text NOT NULL,
	"heading" text,
	"text" text NOT NULL,
	"token_estimate" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "source_kind" NOT NULL,
	"title" text NOT NULL,
	"language" text,
	"status" "source_status" DEFAULT 'processing' NOT NULL,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extracted_text" text DEFAULT '' NOT NULL,
	"text_hash" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD COLUMN "source_locator" text;--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "seller_accounts" ADD COLUMN "delivery_lead_time" jsonb;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_suggestions" ADD CONSTRAINT "playbook_suggestions_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_suggestions" ADD CONSTRAINT "playbook_suggestions_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_suggestions" ADD CONSTRAINT "playbook_suggestions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sections" ADD CONSTRAINT "source_sections_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_sections" ADD CONSTRAINT "source_sections_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_runs_account_created_idx" ON "pipeline_runs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "playbook_suggestions_account_status_idx" ON "playbook_suggestions" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "source_sections_source_position_uq" ON "source_sections" USING btree ("source_id","position");--> statement-breakpoint
CREATE INDEX "source_sections_account_idx" ON "source_sections" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sources_account_created_idx" ON "sources" USING btree ("account_id","created_at");--> statement-breakpoint
ALTER TABLE "knowledge_facts" ADD CONSTRAINT "knowledge_facts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_facts_source_idx" ON "knowledge_facts" USING btree ("source_id");