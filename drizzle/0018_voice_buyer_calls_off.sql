ALTER TABLE "seller_accounts" ADD COLUMN "voice_buyer_calls_off" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "seller_accounts" DROP COLUMN "voice_buyer_calls";