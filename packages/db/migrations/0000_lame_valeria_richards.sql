CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_key" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chain_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"event_kind" text NOT NULL,
	"token_id" bigint NOT NULL,
	"amount_raw" numeric(78, 0) NOT NULL,
	"from_addr" text NOT NULL,
	"to_addr" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"tx_from" text NOT NULL,
	"tx_to" text,
	"provider" text NOT NULL,
	"raw" jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_events_idempotency" UNIQUE("chain_id","tx_hash","log_index","token_id"),
	CONSTRAINT "chain_events_event_kind_check" CHECK (event_kind IN ('native_transfer', 'erc20_transfer', 'gas_fee', 'opening_balance')),
	CONSTRAINT "chain_events_amount_raw_check" CHECK (amount_raw >= 0),
	CONSTRAINT "chain_events_from_addr_check" CHECK (from_addr = lower(from_addr)),
	CONSTRAINT "chain_events_to_addr_check" CHECK (to_addr = lower(to_addr))
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_tenant_id_name_key" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"client_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_kind_check" CHECK (kind IN ('self', 'client', 'vendor', 'exchange', 'contract', 'employee', 'other'))
);
--> statement-breakpoint
CREATE TABLE "entity_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"tenant_id" uuid,
	"chain_id" integer,
	"address" text NOT NULL,
	CONSTRAINT "entity_addresses_tenant_id_chain_id_address_key" UNIQUE NULLS NOT DISTINCT("tenant_id","chain_id","address"),
	CONSTRAINT "entity_addresses_address_check" CHECK (address = lower(address))
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"kind" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_path" text,
	"manifest" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "exports_kind_check" CHECK (kind IN ('close_pack', 'pdf_summary', 'journal_qbo', 'journal_xero')),
	CONSTRAINT "exports_status_check" CHECK (status IN ('pending', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "external_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"kind" text DEFAULT 'invoice' NOT NULL,
	"direction" text NOT NULL,
	"source" text NOT NULL,
	"external_ref" text NOT NULL,
	"counterparty_entity_id" uuid,
	"counterparty_name" text,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"vat_rate" numeric,
	"vat_amount" numeric,
	"issued_on" date,
	"due_on" date,
	"expected_token_id" bigint,
	"expected_address" text,
	"status" text DEFAULT 'open' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_records_import_idempotency" UNIQUE NULLS NOT DISTINCT("tenant_id","client_id","kind","source","external_ref"),
	CONSTRAINT "external_records_direction_check" CHECK (direction IN ('receivable', 'payable')),
	CONSTRAINT "external_records_amount_check" CHECK (amount >= 0),
	CONSTRAINT "external_records_expected_address_check" CHECK (expected_address IS NULL OR expected_address = lower(expected_address)),
	CONSTRAINT "external_records_status_check" CHECK (status IN ('open', 'partially_matched', 'matched', 'overpaid', 'void'))
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fx_rates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"rate_date" date NOT NULL,
	"base_currency" text NOT NULL,
	"quote_currency" text NOT NULL,
	"rate" numeric NOT NULL,
	"source" text DEFAULT 'ecb' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_rate_date_base_currency_quote_currency_source_key" UNIQUE("rate_date","base_currency","quote_currency","source"),
	CONSTRAINT "fx_rates_rate_check" CHECK (rate > 0)
);
--> statement-breakpoint
CREATE TABLE "ingestion_checkpoints" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"stream" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"last_processed_block" bigint DEFAULT 0 NOT NULL,
	"anchor_block" bigint,
	"backfill_started_at" timestamp with time zone,
	"backfill_completed_at" timestamp with time zone,
	"last_integrity" jsonb,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_checkpoints_pkey" PRIMARY KEY("chain_id","address","stream"),
	CONSTRAINT "ingestion_checkpoints_address_check" CHECK (address = lower(address)),
	CONSTRAINT "ingestion_checkpoints_stream_check" CHECK (stream IN ('native', 'erc20')),
	CONSTRAINT "ingestion_checkpoints_status_check" CHECK (status IN ('queued', 'backfilling', 'live', 'paused', 'error'))
);
--> statement-breakpoint
CREATE TABLE "integration_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "integration_credentials_tenant_id_provider_key" UNIQUE("tenant_id","provider"),
	CONSTRAINT "integration_credentials_provider_check" CHECK (provider IN ('quickbooks', 'xero'))
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_record_id" uuid NOT NULL,
	"chain_event_id" bigint NOT NULL,
	"amount_applied_raw" numeric(78, 0) NOT NULL,
	"fiat_value" numeric NOT NULL,
	"fiat_currency" text NOT NULL,
	"price_snapshot_id" bigint,
	"fx_rate_id" bigint,
	"status" text DEFAULT 'suggested' NOT NULL,
	"matched_by" text NOT NULL,
	"confidence" numeric,
	"rationale" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	CONSTRAINT "matches_amount_applied_raw_check" CHECK (amount_applied_raw > 0),
	CONSTRAINT "matches_status_check" CHECK (status IN ('suggested', 'confirmed', 'rejected')),
	CONSTRAINT "matches_matched_by_check" CHECK (matched_by IN ('auto', 'agent', 'manual')),
	CONSTRAINT "matches_confidence_check" CHECK (confidence BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "price_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_id" bigint NOT NULL,
	"price_date" date NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"price" numeric NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_snapshots_token_id_price_date_currency_source_key" UNIQUE("token_id","price_date","currency","source"),
	CONSTRAINT "price_snapshots_price_check" CHECK (price >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_key" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chain_id" integer NOT NULL,
	"address" text,
	"standard" text NOT NULL,
	"symbol_raw" text,
	"name_raw" text,
	"symbol_display" text,
	"name_display" text,
	"decimals" integer NOT NULL,
	"is_stablecoin" boolean DEFAULT false NOT NULL,
	"peg_currency" text,
	"verified" boolean DEFAULT false NOT NULL,
	"coingecko_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_chain_id_address_key" UNIQUE NULLS NOT DISTINCT("chain_id","address"),
	CONSTRAINT "tokens_address_check" CHECK (address IS NULL OR address = lower(address)),
	CONSTRAINT "tokens_standard_check" CHECK (standard IN ('native', 'erc20')),
	CONSTRAINT "tokens_decimals_check" CHECK (decimals BETWEEN 0 AND 36),
	CONSTRAINT "tokens_native_iff_no_addr" CHECK ((standard = 'native') = (address IS NULL))
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb NOT NULL,
	"result_digest" text NOT NULL,
	"coverage" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid,
	"address" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_tenant_id_address_key" UNIQUE("tenant_id","address"),
	CONSTRAINT "wallets_address_check" CHECK (address = lower(address))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_events" ADD CONSTRAINT "chain_events_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_addresses" ADD CONSTRAINT "entity_addresses_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_addresses" ADD CONSTRAINT "entity_addresses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_records" ADD CONSTRAINT "external_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_records" ADD CONSTRAINT "external_records_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_records" ADD CONSTRAINT "external_records_counterparty_entity_id_fkey" FOREIGN KEY ("counterparty_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_records" ADD CONSTRAINT "external_records_expected_token_id_fkey" FOREIGN KEY ("expected_token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_external_record_id_fkey" FOREIGN KEY ("external_record_id") REFERENCES "public"."external_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_chain_event_id_fkey" FOREIGN KEY ("chain_event_id") REFERENCES "public"."chain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_price_snapshot_id_fkey" FOREIGN KEY ("price_snapshot_id") REFERENCES "public"."price_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_fx_rate_id_fkey" FOREIGN KEY ("fx_rate_id") REFERENCES "public"."fx_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chain_events_from_idx" ON "chain_events" USING btree ("from_addr","block_time");--> statement-breakpoint
CREATE INDEX "chain_events_to_idx" ON "chain_events" USING btree ("to_addr","block_time");--> statement-breakpoint
CREATE INDEX "chain_events_block_idx" ON "chain_events" USING btree ("chain_id","block_number");--> statement-breakpoint
CREATE INDEX "chain_events_token_idx" ON "chain_events" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "entities_tenant_idx" ON "entities" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "entity_addresses_addr_idx" ON "entity_addresses" USING btree ("address");--> statement-breakpoint
CREATE INDEX "exports_tenant_idx" ON "exports" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "external_records_status_idx" ON "external_records" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "external_records_period_idx" ON "external_records" USING btree ("tenant_id","issued_on");--> statement-breakpoint
CREATE INDEX "matches_record_idx" ON "matches" USING btree ("external_record_id");--> statement-breakpoint
CREATE INDEX "matches_event_idx" ON "matches" USING btree ("chain_event_id");--> statement-breakpoint
CREATE INDEX "matches_status_idx" ON "matches" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "tool_calls_tenant_time_idx" ON "tool_calls" USING btree ("tenant_id","called_at");--> statement-breakpoint
CREATE INDEX "wallets_address_idx" ON "wallets" USING btree ("address");