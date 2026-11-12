CREATE TYPE "public"."intake_result" AS ENUM('created', 'updated', 'rejected');--> statement-breakpoint
CREATE TABLE "lead_intake_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"key_id" uuid,
	"result" "intake_result" NOT NULL,
	"reason" text,
	"lead_id" uuid,
	"lead_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_intake_keys" ADD COLUMN "key_last4" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "lead_intake_deliveries" ADD CONSTRAINT "lead_intake_deliveries_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_intake_deliveries" ADD CONSTRAINT "lead_intake_deliveries_key_id_lead_intake_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."lead_intake_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_intake_deliveries" ADD CONSTRAINT "lead_intake_deliveries_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_intake_deliveries_account_created_idx" ON "lead_intake_deliveries" USING btree ("account_id","created_at");