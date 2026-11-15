CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rate_limits_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE INDEX "rate_limits_window_idx" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "audit_log_created_id_idx" ON "audit_log" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "conversations_account_agent_version_created_idx" ON "conversations" USING btree ("account_id","agent_version_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_facts_account_topic_idx" ON "knowledge_facts" USING btree ("account_id","topic");--> statement-breakpoint
CREATE INDEX "lead_events_account_created_idx" ON "lead_events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_account_created_idx" ON "leads" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "order_forms_account_status_idx" ON "order_forms" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "order_forms_account_created_idx" ON "order_forms" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "order_forms_quote_created_idx" ON "order_forms" USING btree ("quote_id","created_at");--> statement-breakpoint
CREATE INDEX "order_forms_lead_created_idx" ON "order_forms" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_account_created_idx" ON "orders" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_account_payment_status_idx" ON "orders" USING btree ("account_id","payment_status");--> statement-breakpoint
CREATE INDEX "orders_account_paid_idx" ON "orders" USING btree ("account_id","paid_at");--> statement-breakpoint
CREATE INDEX "orders_quote_idx" ON "orders" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "orders_lead_created_idx" ON "orders" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_order_created_idx" ON "payment_attempts" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "quotes_account_created_idx" ON "quotes" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_message_idx" ON "tool_calls" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "tool_calls_account_name_created_idx" ON "tool_calls" USING btree ("account_id","name","created_at");