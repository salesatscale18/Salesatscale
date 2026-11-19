CREATE TABLE "voice_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_version_id" uuid,
	"started_by_user_id" uuid,
	"is_test" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"error_code" text,
	"model" text NOT NULL,
	"mode" text NOT NULL,
	"provider_session_id" text,
	"duration_sec" integer,
	"answer_ms_avg" integer,
	"usage" jsonb,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"settings" jsonb,
	"ticket_hash" text NOT NULL,
	"ticket_used_at" timestamp with time zone,
	"recording_consent" boolean,
	"recording_ref" text
);
--> statement-breakpoint
ALTER TABLE "agent_versions" ADD COLUMN "voice_settings" jsonb;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "voice_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "recording_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "voice_session_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "spoken_at_ms" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "answer_ms" integer;--> statement-breakpoint
ALTER TABLE "seller_accounts" ADD COLUMN "voice_buyer_calls" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_sessions_account_created_idx" ON "voice_sessions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "voice_sessions_conversation_idx" ON "voice_sessions" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_voice_session_id_voice_sessions_id_fk" FOREIGN KEY ("voice_session_id") REFERENCES "public"."voice_sessions"("id") ON DELETE set null ON UPDATE no action;