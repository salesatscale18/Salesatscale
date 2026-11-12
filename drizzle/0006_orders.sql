CREATE TYPE "public"."order_form_status" AS ENUM('sent', 'opened', 'signed', 'link_expired');--> statement-breakpoint
CREATE TYPE "public"."payment_attempt_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('not_started', 'pending', 'paid', 'failed', 'refunded', 'bank_transfer_expected');--> statement-breakpoint
CREATE TABLE "legal_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"title" text NOT NULL,
	"language" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_form_settings" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"fields" jsonb NOT NULL,
	"card" boolean DEFAULT true NOT NULL,
	"bank_transfer" boolean DEFAULT true NOT NULL,
	"bank_details" text,
	"link_valid_days" integer DEFAULT 7 NOT NULL,
	"brand_color" text DEFAULT '#0f6b5a' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_forms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"quote_version_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"language" text NOT NULL,
	"status" "order_form_status" DEFAULT 'sent' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"superseded_by_id" uuid,
	"opened_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_forms_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"order_form_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"payment_status" "payment_status" DEFAULT 'not_started' NOT NULL,
	"payment_method" text,
	"currency" text NOT NULL,
	"amount_due_minor" integer NOT NULL,
	"recurring_minor" integer NOT NULL,
	"recurring_consent" boolean DEFAULT false NOT NULL,
	"paid_at" timestamp with time zone,
	"marked_paid_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_form_id_unique" UNIQUE("order_form_id")
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"status" "payment_attempt_status" DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_provider_ref_unique" UNIQUE("provider_ref")
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"raw" jsonb NOT NULL,
	"result" text NOT NULL,
	"account_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signatures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"order_form_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"role" text,
	"buyer_fields" jsonb NOT NULL,
	"agreed" boolean NOT NULL,
	"legal_versions" jsonb NOT NULL,
	"document_hash" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signatures_order_form_id_unique" UNIQUE("order_form_id")
);
--> statement-breakpoint
ALTER TABLE "legal_sections" ADD CONSTRAINT "legal_sections_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_sections" ADD CONSTRAINT "legal_sections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_form_settings" ADD CONSTRAINT "order_form_settings_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_forms" ADD CONSTRAINT "order_forms_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_forms" ADD CONSTRAINT "order_forms_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_forms" ADD CONSTRAINT "order_forms_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_forms" ADD CONSTRAINT "order_forms_quote_version_id_quote_versions_id_fk" FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_forms" ADD CONSTRAINT "order_forms_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_order_form_id_order_forms_id_fk" FOREIGN KEY ("order_form_id") REFERENCES "public"."order_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_marked_paid_by_user_id_users_id_fk" FOREIGN KEY ("marked_paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_order_form_id_order_forms_id_fk" FOREIGN KEY ("order_form_id") REFERENCES "public"."order_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_sections_version_uq" ON "legal_sections" USING btree ("account_id","section_key","language","version");--> statement-breakpoint
CREATE INDEX "order_forms_quote_idx" ON "order_forms" USING btree ("account_id","quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_number_uq" ON "orders" USING btree ("account_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_events_dedupe_uq" ON "provider_events" USING btree ("provider","dedupe_key");