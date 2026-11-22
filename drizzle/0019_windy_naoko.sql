ALTER TABLE "seller_accounts" ADD COLUMN "voice_settings" jsonb;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "recording_state" text;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "recording_chunks" integer;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "recording_bytes" bigint;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "recording_sec" integer;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "recording_notice_said" boolean;