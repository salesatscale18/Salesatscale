CREATE TYPE "public"."rollout_mode" AS ENUM('test_only', 'half', 'all');--> statement-breakpoint
ALTER TABLE "seller_accounts" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "seller_accounts" ADD COLUMN "support_contact" text;--> statement-breakpoint
ALTER TABLE "seller_accounts" ADD COLUMN "sales_rep_user_id" uuid;--> statement-breakpoint
ALTER TABLE "seller_accounts" ADD COLUMN "contact_hours" jsonb;--> statement-breakpoint
ALTER TABLE "seller_accounts" ADD COLUMN "notifications" jsonb;--> statement-breakpoint
ALTER TABLE "seller_accounts" ADD COLUMN "rollout" "rollout_mode" DEFAULT 'test_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "seller_accounts" ADD CONSTRAINT "seller_accounts_sales_rep_user_id_users_id_fk" FOREIGN KEY ("sales_rep_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;