ALTER TABLE "ingestion_checkpoints" DROP CONSTRAINT "ingestion_checkpoints_status_check";--> statement-breakpoint
ALTER TABLE "ingestion_checkpoints" ADD COLUMN "anchor_from" date;--> statement-breakpoint
ALTER TABLE "ingestion_checkpoints" ADD COLUMN "tx_count_hint" bigint;--> statement-breakpoint
ALTER TABLE "ingestion_checkpoints" ADD CONSTRAINT "ingestion_checkpoints_status_check" CHECK (status IN ('queued', 'anchoring', 'backfilling', 'live', 'paused', 'error'));