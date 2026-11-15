CREATE TYPE "public"."lead_origin" AS ENUM('manual', 'csv', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'waiting_for_reply', 'agent_handling', 'human_handling', 'meeting_booked', 'won', 'lost', 'opted_out');--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"wording" text NOT NULL,
	"source" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"ip" text,
	"page_url" text,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"actor_user_id" uuid,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_intake_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_intake_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"company" text,
	"phone" text NOT NULL,
	"language" text NOT NULL,
	"origin" "lead_origin" NOT NULL,
	"source_label" text,
	"source_ref" text,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"owner_user_id" uuid,
	"opted_out_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_intake_keys" ADD CONSTRAINT "lead_intake_keys_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_intake_keys" ADD CONSTRAINT "lead_intake_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_records_lead_idx" ON "consent_records" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "lead_events_lead_created_idx" ON "lead_events" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_intake_keys_account_idx" ON "lead_intake_keys" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_account_phone_uq" ON "leads" USING btree ("account_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_account_source_ref_uq" ON "leads" USING btree ("account_id","source_ref") WHERE "leads"."source_ref" is not null;--> statement-breakpoint
CREATE INDEX "leads_account_status_idx" ON "leads" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "leads_account_activity_idx" ON "leads" USING btree ("account_id","last_activity_at");