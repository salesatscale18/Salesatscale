CREATE TYPE "public"."item_kind" AS ENUM('product', 'service');--> statement-breakpoint
CREATE TYPE "public"."market_status" AS ENUM('setting_up', 'live', 'paused');--> statement-breakpoint
CREATE TYPE "public"."price_list_status" AS ENUM('draft', 'live', 'archived');--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_home" boolean DEFAULT false NOT NULL,
	"status" "market_status" DEFAULT 'setting_up' NOT NULL,
	"countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"phone_prefixes" text[] DEFAULT '{}'::text[] NOT NULL,
	"form_country_values" text[] DEFAULT '{}'::text[] NOT NULL,
	"intake_key_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"price_list_lineage_id" uuid,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_list_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"one_time_charged" boolean DEFAULT false NOT NULL,
	"one_time_minor" integer,
	"one_time_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recurring_charged" boolean DEFAULT false NOT NULL,
	"recurring_minor" integer,
	"recurring_period" text,
	"recurring_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_pricing_from_qty" integer
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"lineage_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"prices_include_tax" boolean DEFAULT true NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"valid_from" date,
	"version" integer NOT NULL,
	"status" "price_list_status" DEFAULT 'draft' NOT NULL,
	"copied_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "kind" "item_kind";--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "unit_custom" jsonb;--> statement-breakpoint
ALTER TABLE "lead_intake_keys" ADD COLUMN "market_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "market_id" uuid;--> statement-breakpoint
ALTER TABLE "legal_sections" ADD COLUMN "market_id" uuid;--> statement-breakpoint
ALTER TABLE "order_forms" ADD COLUMN "market_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "market_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN "market_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN "price_list_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "market_id" uuid;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_copied_from_id_price_lists_id_fk" FOREIGN KEY ("copied_from_id") REFERENCES "public"."price_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "markets_account_idx" ON "markets" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_one_home_uq" ON "markets" USING btree ("account_id") WHERE "markets"."is_home";--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_entries_list_sku_uq" ON "price_list_entries" USING btree ("price_list_id","sku");--> statement-breakpoint
CREATE INDEX "price_lists_account_idx" ON "price_lists" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_lineage_version_uq" ON "price_lists" USING btree ("lineage_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_one_draft_uq" ON "price_lists" USING btree ("lineage_id") WHERE "price_lists"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_one_live_uq" ON "price_lists" USING btree ("lineage_id") WHERE "price_lists"."status" = 'live';--> statement-breakpoint
ALTER TABLE "lead_intake_keys" ADD CONSTRAINT "lead_intake_keys_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_sections" ADD CONSTRAINT "legal_sections_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_forms" ADD CONSTRAINT "order_forms_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_account_market_idx" ON "leads" USING btree ("account_id","market_id");