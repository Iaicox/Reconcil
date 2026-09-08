DROP INDEX "chain_events_token_idx";--> statement-breakpoint
CREATE INDEX "chain_events_token_time_idx" ON "chain_events" USING btree ("token_id","block_time");