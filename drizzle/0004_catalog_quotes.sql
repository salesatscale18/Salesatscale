CREATE TYPE "public"."catalog_version_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."charge_type" AS ENUM('one_time', 'recurring');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'awaiting_approval', 'sent', 'replaced', 'cancelled');--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"charge_type" charge_type NOT NULL,
	"period" text,
	"unit" text NOT NULL,
	"price_minor" integer,
	"volume_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_pricing_from_qty" integer,
	"active" boolean DEFAULT true NOT NULL,
	"availability_note" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "catalog_version_status" DEFAULT 'draft' NOT NULL,
	"prices_include_tax" boolean DEFAULT true NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fit_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"rule" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"quote_version_id" uuid NOT NULL,
	"catalog_item_id" uuid,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"charge_type" charge_type NOT NULL,
	"period" text,
	"unit" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_minor" integer,
	"price_source" text NOT NULL,
	"line_total_minor" integer,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"catalog_version_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"prices_include_tax" boolean NOT NULL,
	"tax_rate_bp" integer NOT NULL,
	"one_time_subtotal_minor" integer NOT NULL,
	"one_time_discount_minor" integer NOT NULL,
	"one_time_tax_minor" integer NOT NULL,
	"one_time_total_minor" integer NOT NULL,
	"recurring_subtotal_minor" integer NOT NULL,
	"recurring_discount_minor" integer NOT NULL,
	"recurring_tax_minor" integer NOT NULL,
	"recurring_total_minor" integer NOT NULL,
	"recurring_period" text,
	"approval_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"valid_until" timestamp with time zone NOT NULL,
	"change_note" text,
	"created_by_actor" text NOT NULL,
	"created_by_user_id" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seller_accounts" ADD COLUMN "max_discount_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_catalog_version_id_catalog_versions_id_fk" FOREIGN KEY ("catalog_version_id") REFERENCES "public"."catalog_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_versions" ADD CONSTRAINT "catalog_versions_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_versions" ADD CONSTRAINT "catalog_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_rules" ADD CONSTRAINT "fit_rules_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_rules" ADD CONSTRAINT "fit_rules_catalog_version_id_catalog_versions_id_fk" FOREIGN KEY ("catalog_version_id") REFERENCES "public"."catalog_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_version_id_quote_versions_id_fk" FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_catalog_version_id_catalog_versions_id_fk" FOREIGN KEY ("catalog_version_id") REFERENCES "public"."catalog_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_items_version_sku_uq" ON "catalog_items" USING btree ("catalog_version_id","sku");--> statement-breakpoint
CREATE INDEX "catalog_items_account_idx" ON "catalog_items" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_versions_account_version_uq" ON "catalog_versions" USING btree ("account_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_versions_one_draft_uq" ON "catalog_versions" USING btree ("account_id") WHERE "catalog_versions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_versions_one_published_uq" ON "catalog_versions" USING btree ("account_id") WHERE "catalog_versions"."status" = 'published';--> statement-breakpoint
CREATE INDEX "fit_rules_version_idx" ON "fit_rules" USING btree ("catalog_version_id");--> statement-breakpoint
CREATE INDEX "quote_lines_version_idx" ON "quote_lines" USING btree ("quote_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_versions_quote_version_uq" ON "quote_versions" USING btree ("quote_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_versions_account_idem_uq" ON "quote_versions" USING btree ("account_id","idempotency_key") WHERE "quote_versions"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_account_number_uq" ON "quotes" USING btree ("account_id","number");--> statement-breakpoint
CREATE INDEX "quotes_account_status_idx" ON "quotes" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "quotes_lead_idx" ON "quotes" USING btree ("lead_id");