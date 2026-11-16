CREATE TYPE "public"."channel_connection_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."template_purpose" AS ENUM('opener', 'follow_up');--> statement-breakpoint
CREATE TYPE "public"."template_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "channel_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"provider" text DEFAULT 'twilio' NOT NULL,
	"sender_number" text NOT NULL,
	"display_name" text,
	"messaging_service_sid" text,
	"market_id" uuid,
	"status" "channel_connection_status" DEFAULT 'active' NOT NULL,
	"tester_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"last_error" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"content_sid" text NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"purpose" "template_purpose" NOT NULL,
	"body" text NOT NULL,
	"category" text,
	"status" "template_status" DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"status_checked_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "channel_address" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "channel_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_error" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_channel_sender_uq" ON "channel_connections" USING btree ("channel","sender_number");--> statement-breakpoint
CREATE INDEX "channel_connections_account_idx" ON "channel_connections" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_account_content_uq" ON "message_templates" USING btree ("account_id","content_sid");--> statement-breakpoint
CREATE INDEX "message_templates_account_purpose_idx" ON "message_templates" USING btree ("account_id","purpose","language");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_template_id_message_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_message_id_uq" ON "messages" USING btree ("channel_message_id") WHERE "messages"."channel_message_id" is not null;