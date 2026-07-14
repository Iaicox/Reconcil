-- =============================================================================
-- On-chain Accounting Ledger — core schema (PostgreSQL 16)
-- Design rationale: docs/architecture/01-data-model.md
-- Conventions:
--   * all addresses and tx hashes are lowercase 0x-hex TEXT (enforced by CHECK)
--   * all token amounts in base units: NUMERIC(78,0)  (uint256 fits; BIGINT does not)
--   * fiat amounts: unconstrained NUMERIC (display units of the named currency)
--   * global (tenant-neutral) tables: tokens, chain_events, price_snapshots,
--     fx_rates, ingestion_checkpoints  — public chain data, deduplicated
--   * tenant-owned tables carry tenant_id NOT NULL (except entities: NULL = curated)
-- =============================================================================

-- ---------------------------------------------------------------- tenancy ---

CREATE TABLE tenants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    -- valuation_policy ('market'|'peg_for_stables'), base_currency, locale...
    settings    JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An accounting firm's sub-clients ($199 multi-client tier). Optional in
-- single-company mode (wallets.client_id stays NULL).
CREATE TABLE clients (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    base_currency  TEXT NOT NULL DEFAULT 'USD',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE wallets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id   UUID REFERENCES clients(id) ON DELETE SET NULL,
    address     TEXT NOT NULL CHECK (address = lower(address)),
    label       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, address)
);
-- Reverse lookup: which tenants track this address (ingestion fan-out, event scoping).
CREATE INDEX wallets_address_idx ON wallets (address);

-- Bearer keys for the hosted streamable-HTTP transport (ADR-012).
CREATE TABLE api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key_hash    TEXT NOT NULL UNIQUE,          -- sha256(key); plaintext never stored
    label       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ
);

-- ------------------------------------------------------------ chain data ---

-- Global token registry. The native currency of each chain is a pseudo-token
-- row (address IS NULL) so every event references a token uniformly.
CREATE TABLE tokens (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chain_id        INTEGER NOT NULL,
    address         TEXT CHECK (address IS NULL OR address = lower(address)),
    standard        TEXT NOT NULL CHECK (standard IN ('native', 'erc20')),
    symbol_raw      TEXT,              -- as fetched on-chain: HOSTILE, never shown to LLM
    name_raw        TEXT,              -- HOSTILE
    symbol_display  TEXT,              -- sanitized (core/sanitizer), safe for LLM context
    name_display    TEXT,              -- sanitized
    decimals        INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 36),
    is_stablecoin   BOOLEAN NOT NULL DEFAULT false,
    peg_currency    TEXT,              -- 'USD' | 'EUR' when is_stablecoin
    verified        BOOLEAN NOT NULL DEFAULT false,  -- curated allowlist vs auto-discovered (spam)
    coingecko_id    TEXT,              -- price-source mapping; DefiLlama keys by (chain, address)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tokens_native_iff_no_addr CHECK ((standard = 'native') = (address IS NULL)),
    UNIQUE NULLS NOT DISTINCT (chain_id, address)
);

-- Append-only event store (P3). GLOBAL: public chain data, shared across tenants.
-- Rows are never updated or deleted; reorg safety is by construction (ingestion
-- never passes head - finality_depth, see 03-ingestion.md).
CREATE TABLE chain_events (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chain_id     INTEGER NOT NULL,
    tx_hash      TEXT NOT NULL,        -- lowercase 0x-hex(64); synthetic 'anchor:<addr>:<block>' for opening_balance
    log_index    INTEGER NOT NULL,     -- sentinels: -1 native transfer, -2 gas fee, -3 opening balance;
                                       -- reserved: -(1000+n) for future internal (trace) transfers
    event_kind   TEXT NOT NULL CHECK (event_kind IN
                     ('native_transfer', 'erc20_transfer', 'gas_fee', 'opening_balance')),
    token_id     BIGINT NOT NULL REFERENCES tokens(id),
    amount_raw   NUMERIC(78,0) NOT NULL CHECK (amount_raw >= 0),
    from_addr    TEXT NOT NULL CHECK (from_addr = lower(from_addr)),
    to_addr      TEXT NOT NULL CHECK (to_addr = lower(to_addr)),
    block_number BIGINT NOT NULL,
    block_time   TIMESTAMPTZ NOT NULL,
    tx_from      TEXT NOT NULL,        -- tx-level sender (gas payer, counterparty resolution)
    tx_to        TEXT,                 -- NULL for contract creation
    provider     TEXT NOT NULL,        -- which provider supplied this row (audit)
    raw          JSONB NOT NULL,       -- provider payload as received; server-side only, never sent to LLM
    ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Idempotency key (P3/P4): safe re-ingestion via ON CONFLICT DO NOTHING.
    CONSTRAINT chain_events_idempotency UNIQUE (chain_id, tx_hash, log_index)
);
-- Flow queries: "events where X is sender/recipient in period".
-- chain_id is filtered after the address probe: address selectivity dominates.
CREATE INDEX chain_events_from_idx  ON chain_events (from_addr, block_time);
CREATE INDEX chain_events_to_idx    ON chain_events (to_addr, block_time);
-- Integrity checks and coverage math per chain height.
CREATE INDEX chain_events_block_idx ON chain_events (chain_id, block_number);
-- Token-level scans (stablecoin movement queries, spam audits).
CREATE INDEX chain_events_token_idx ON chain_events (token_id);

-- ---------------------------------------------------------------- pricing ---

-- Daily UTC close snapshots (P5). Append-only: corrections are new rows under a
-- different source ('manual'); calculations pin the exact row they used by FK.
CREATE TABLE price_snapshots (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_id    BIGINT NOT NULL REFERENCES tokens(id),
    price_date  DATE NOT NULL,                    -- UTC day
    currency    TEXT NOT NULL DEFAULT 'USD',
    price       NUMERIC NOT NULL CHECK (price >= 0),  -- per 1 whole token (display units)
    source      TEXT NOT NULL,                    -- 'defillama' | 'coingecko' | 'peg' | 'manual'
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (token_id, price_date, currency, source)
);

-- ECB daily reference rates (P5). Weekend/holiday rule: use latest prior row.
CREATE TABLE fx_rates (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rate_date       DATE NOT NULL,
    base_currency   TEXT NOT NULL,     -- 'EUR' (ECB publishes EUR-based)
    quote_currency  TEXT NOT NULL,     -- 'USD', ...
    rate            NUMERIC NOT NULL CHECK (rate > 0),
    source          TEXT NOT NULL DEFAULT 'ecb',
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (rate_date, base_currency, quote_currency, source)
);

-- -------------------------------------------------------------- directory ---

-- Address book. tenant_id NULL = built-in curated labels (exchanges, routers),
-- shipped as seed data, read-only for tenants.
CREATE TABLE entities (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
    client_id   UUID REFERENCES clients(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN
                    ('self', 'client', 'vendor', 'exchange', 'contract', 'employee', 'other')),
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX entities_tenant_idx ON entities (tenant_id);

CREATE TABLE entity_addresses (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id  UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    -- Denormalized from entities to make the uniqueness rule enforceable in-DB:
    -- one owner per (tenant, chain, address). Kept in sync by the repository layer.
    tenant_id  UUID REFERENCES tenants(id) ON DELETE CASCADE,
    chain_id   INTEGER,                -- NULL = applies to any EVM chain
    address    TEXT NOT NULL CHECK (address = lower(address)),
    UNIQUE NULLS NOT DISTINCT (tenant_id, chain_id, address)
);
CREATE INDEX entity_addresses_addr_idx ON entity_addresses (address);

-- ---------------------------------------------------------- reconciliation ---

-- Source-agnostic external records (Option C seam #1): an invoice is just one
-- `kind`. Future kinds ('bill', 'agent_charge', ...) reuse the matching engine.
CREATE TABLE external_records (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id               UUID REFERENCES clients(id) ON DELETE SET NULL,
    kind                    TEXT NOT NULL DEFAULT 'invoice',
    direction               TEXT NOT NULL CHECK (direction IN ('receivable', 'payable')),
    source                  TEXT NOT NULL,          -- 'csv' | 'manual' | 'api'
    external_ref            TEXT NOT NULL,          -- invoice number etc.
    counterparty_entity_id  UUID REFERENCES entities(id),
    counterparty_name       TEXT,                   -- raw from import: HOSTILE
    amount                  NUMERIC NOT NULL CHECK (amount >= 0),   -- gross, in `currency`
    currency                TEXT NOT NULL,          -- 'EUR' | 'USD' | ...
    vat_rate                NUMERIC,                -- percent, e.g. 21.0
    vat_amount              NUMERIC,
    issued_on               DATE,
    due_on                  DATE,
    expected_token_id       BIGINT REFERENCES tokens(id),
    expected_address        TEXT CHECK (expected_address IS NULL OR expected_address = lower(expected_address)),
    status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN
                                ('open', 'partially_matched', 'matched', 'overpaid', 'void')),
    payload                 JSONB NOT NULL DEFAULT '{}',   -- raw import row (audit)
    imported_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Idempotent re-import of the same CSV.
    UNIQUE (tenant_id, kind, source, external_ref)
);
CREATE INDEX external_records_status_idx ON external_records (tenant_id, status);
CREATE INDEX external_records_period_idx ON external_records (tenant_id, issued_on);

-- Pair-level match legs: m:n between external records and settlement events
-- (partial payments, overpayments, split settlements, fee shortfalls).
CREATE TABLE matches (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    external_record_id  UUID NOT NULL REFERENCES external_records(id) ON DELETE CASCADE,
    chain_event_id      BIGINT NOT NULL REFERENCES chain_events(id),
    -- Portion of the event applied to this record, token base units.
    amount_applied_raw  NUMERIC(78,0) NOT NULL CHECK (amount_applied_raw > 0),
    -- Valuation of that portion, pinned to the exact price/FX rows used (P5).
    fiat_value          NUMERIC NOT NULL,
    fiat_currency       TEXT NOT NULL,
    price_snapshot_id   BIGINT REFERENCES price_snapshots(id),
    fx_rate_id          BIGINT REFERENCES fx_rates(id),
    status              TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN
                            ('suggested', 'confirmed', 'rejected')),
    matched_by          TEXT NOT NULL CHECK (matched_by IN ('auto', 'agent', 'manual')),
    confidence          NUMERIC CHECK (confidence BETWEEN 0 AND 1),
    rationale           JSONB NOT NULL DEFAULT '{}',   -- rule hits explaining the suggestion
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at        TIMESTAMPTZ,
    confirmed_by        TEXT
);
CREATE INDEX matches_record_idx ON matches (external_record_id);
CREATE INDEX matches_event_idx  ON matches (chain_event_id);
CREATE INDEX matches_status_idx ON matches (tenant_id, status);
-- Cross-row invariants (sum of applied ≤ event amount; record status derivation)
-- are enforced in the repository layer under SERIALIZABLE tx + property tests
-- (triggers rejected: logic duplication, see ADR-010).

-- --------------------------------------------------------------- ingestion ---

-- Cursor per (chain, address, stream). GLOBAL: two tenants tracking the same
-- address share one checkpoint and one backfill. 'native' and 'erc20' are
-- separate provider endpoints, hence separate cursors.
CREATE TABLE ingestion_checkpoints (
    chain_id              INTEGER NOT NULL,
    address               TEXT NOT NULL CHECK (address = lower(address)),
    stream                TEXT NOT NULL CHECK (stream IN ('native', 'erc20')),
    status                TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                              ('queued', 'backfilling', 'live', 'paused', 'error')),
    -- Events are complete for blocks <= last_processed_block (within coverage).
    last_processed_block  BIGINT NOT NULL DEFAULT 0,
    -- Non-NULL => anchored-window backfill: coverage starts here, opening_balance
    -- event anchors the baseline (ADR-008).
    anchor_block          BIGINT,
    backfill_started_at   TIMESTAMPTZ,
    backfill_completed_at TIMESTAMPTZ,
    -- Last balance-vs-provider drift check result: {checked_at, block, drifts:[...]}.
    last_integrity        JSONB,
    last_error            TEXT,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, address, stream)
);

-- ---------------------------------------------------------------- interface ---

-- Persisted tool invocations: the anchor for citations (P2). Every MCP tool
-- response carries a tool_call_id referencing a row here; trace_tool_call
-- replays it. Also the audit/usage log.
CREATE TABLE tool_calls (
    id             TEXT PRIMARY KEY,             -- ULID (lexically time-ordered)
    tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tool_name      TEXT NOT NULL,
    args           JSONB NOT NULL,
    result_digest  TEXT NOT NULL,                -- sha256 of canonical result JSON
    coverage       JSONB NOT NULL DEFAULT '[]',  -- coverage snapshot at call time (replayable)
    called_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tool_calls_tenant_time_idx ON tool_calls (tenant_id, called_at);

-- QuickBooks/Xero OAuth tokens, AES-256-GCM under MASTER_KEY (P9). Plaintext
-- exists only in memory during an export run; key_version enables rotation.
CREATE TABLE integration_credentials (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL CHECK (provider IN ('quickbooks', 'xero')),
    ciphertext   BYTEA NOT NULL,
    nonce        BYTEA NOT NULL,
    key_version  INTEGER NOT NULL DEFAULT 1,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at   TIMESTAMPTZ,
    UNIQUE (tenant_id, provider)
);

-- Export artifact registry + audit manifest (which coverage, price snapshots
-- and tool calls produced each file).
CREATE TABLE exports (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id     UUID REFERENCES clients(id) ON DELETE SET NULL,
    kind          TEXT NOT NULL CHECK (kind IN
                      ('close_pack', 'pdf_summary', 'journal_qbo', 'journal_xero')),
    period_start  DATE NOT NULL,
    period_end    DATE NOT NULL,
    params        JSONB NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                      ('pending', 'running', 'done', 'failed')),
    file_path     TEXT,
    manifest      JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ
);
CREATE INDEX exports_tenant_idx ON exports (tenant_id, created_at);
