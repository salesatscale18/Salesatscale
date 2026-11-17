ALTER TABLE "order_forms" ADD COLUMN "draft" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_preference" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "preferred_delivery_date" date;