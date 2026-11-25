CREATE TYPE "public"."lead_page_connection" AS ENUM('snippet', 'own_form', 'link', 'hosted');--> statement-breakpoint
CREATE TYPE "public"."lead_page_status" AS ENUM('draft', 'live', 'paused');--> statement-breakpoint
CREATE TABLE "lead_page_daily" (
	"account_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"day" date NOT NULL,
	"source_key" text DEFAULT '' NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"opens" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "lead_page_daily_pk" PRIMARY KEY("page_id","day","source_key")
);
--> statement-breakpoint
CREATE TABLE "lead_page_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"via" text NOT NULL,
	"lead_created" boolean NOT NULL,
	"consent" boolean NOT NULL,
	"preview" boolean DEFAULT false NOT NULL,
	"language" text NOT NULL,
	"answers" jsonb,
	"ad" jsonb,
	"source_key" text DEFAULT '' NOT NULL,
	"pixel" jsonb,
	"conversation_id" uuid,
	"handover_at" timestamp with time zone,
	"chat_choice" text,
	"sms" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"extra_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"connection" "lead_page_connection" NOT NULL,
	"status" "lead_page_status" DEFAULT 'draft' NOT NULL,
	"market_id" uuid,
	"language" text NOT NULL,
	"form" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opening_topic" jsonb,
	"banner" jsonb,
	"tracking" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"went_live_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_pages_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "lead_page_id" uuid;--> statement-breakpoint
ALTER TABLE "lead_page_daily" ADD CONSTRAINT "lead_page_daily_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_page_daily" ADD CONSTRAINT "lead_page_daily_page_id_lead_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."lead_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_page_submissions" ADD CONSTRAINT "lead_page_submissions_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_page_submissions" ADD CONSTRAINT "lead_page_submissions_page_id_lead_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."lead_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_page_submissions" ADD CONSTRAINT "lead_page_submissions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_page_submissions" ADD CONSTRAINT "lead_page_submissions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_pages" ADD CONSTRAINT "lead_pages_account_id_seller_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."seller_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_pages" ADD CONSTRAINT "lead_pages_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_pages" ADD CONSTRAINT "lead_pages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_page_daily_account_day_idx" ON "lead_page_daily" USING btree ("account_id","day");--> statement-breakpoint
CREATE INDEX "lead_page_submissions_page_created_idx" ON "lead_page_submissions" USING btree ("account_id","page_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_page_submissions_lead_idx" ON "lead_page_submissions" USING btree ("account_id","lead_id");--> statement-breakpoint
CREATE INDEX "lead_page_submissions_page_lead_idx" ON "lead_page_submissions" USING btree ("account_id","page_id","lead_id");--> statement-breakpoint
CREATE INDEX "lead_pages_account_status_idx" ON "lead_pages" USING btree ("account_id","status");--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_lead_page_id_lead_pages_id_fk" FOREIGN KEY ("lead_page_id") REFERENCES "public"."lead_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_account_lead_page_idx" ON "leads" USING btree ("account_id","lead_page_id");