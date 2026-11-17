CREATE TABLE "simulator_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "simulator_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "buyer_ref" text;--> statement-breakpoint
ALTER TABLE "seller_accounts" ADD COLUMN "simulate_whatsapp_rules" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "seller_accounts" ADD COLUMN "allow_simulated_buyers" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "simulator_links" ADD CONSTRAINT "simulator_links_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulator_links" ADD CONSTRAINT "simulator_links_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulator_links" ADD CONSTRAINT "simulator_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "simulator_links_account_lead_idx" ON "simulator_links" USING btree ("account_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "simulator_links_one_active_uq" ON "simulator_links" USING btree ("lead_id") WHERE "simulator_links"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_account_buyer_ref_uq" ON "leads" USING btree ("account_id","buyer_ref") WHERE "leads"."buyer_ref" is not null;