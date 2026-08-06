/**
 * Zod v4 schemas — the source of truth for MCP tool contracts (02-mcp-contracts).
 * JSON Schema in tool declarations is generated from these (`z.toJSONSchema`), and
 * tool outputs are validated against them at runtime (a tool that breaks its own
 * contract fails loudly). Money crosses as a `DecimalString` — a string, never a
 * JSON number (ADR-004); `z.string()` rejects numbers structurally.
 */
import { z } from 'zod';

/** Display/fiat money on the wire: a decimal string, never a JSON number (ADR-004). */
export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

/** A decimal string that cannot be negative — thresholds/amounts (e.g. `min_amount`). */
export const nonNegativeDecimalString = z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string');

// ---- shared inputs (§5) -----------------------------------------------------

export const scopeSchema = z
  .object({
    wallet_ids: z.array(z.string()).optional(),
    client_id: z.string().optional(),
    addresses: z.array(z.string()).optional(),
  })
  .strict();
export type Scope = z.infer<typeof scopeSchema>;

/** ISO calendar date on the wire (UTC day); malformed dates fail as INVALID_INPUT. */
export const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

export const periodSchema = z.object({ from: isoDateString, to: isoDateString }).strict();
export type Period = z.infer<typeof periodSchema>;

export const valuationSchema = z
  .object({
    currency: z.enum(['USD', 'EUR']),
    policy: z.enum(['market', 'peg_for_stables']).optional(),
  })
  .strict();
export type Valuation = z.infer<typeof valuationSchema>;

// ---- envelope pieces (§2) ---------------------------------------------------

export const warningCode = z.enum([
  'COVERAGE_INCOMPLETE', 'ANCHORED_BASELINE', 'DATA_STALE', 'UNVERIFIED_EXCLUDED',
  'PRICE_MISSING', 'FX_DATE_SHIFTED', 'SANITIZED_HEAVY', 'ROUNDING_RESIDUE',
]);
export type WarningCode = z.infer<typeof warningCode>;

export const warningSchema = z.object({
  code: warningCode,
  message: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
});
export type Warning = z.infer<typeof warningSchema>;

export const eventRefSchema = z.object({
  chain_id: z.number(), tx_hash: z.string(), log_index: z.number(),
});
export type EventRef = z.infer<typeof eventRefSchema>;

export const coverageRefSchema = z.object({
  chain_id: z.number(),
  address: z.string(),
  streams: z.array(z.enum(['native', 'erc20'])),
  from_block: z.number().nullable(),
  to_block: z.number(),
  anchor_block: z.number().optional(),
  status: z.enum(['live', 'backfilling', 'error', 'paused']),
});
export type CoverageRef = z.infer<typeof coverageRefSchema>;

export const priceRefSchema = z.object({
  snapshot_id: z.number(), token: z.string(), date: z.string(),
  currency: z.string(), source: z.string(), price: decimalString,
});
export type PriceRef = z.infer<typeof priceRefSchema>;

export const fxRefSchema = z.object({
  fx_rate_id: z.number(), date: z.string(), base: z.string(),
  quote: z.string(), rate: decimalString, source: z.string(),
});
export type FxRef = z.infer<typeof fxRefSchema>;

export const eventRefSummarySchema = z.object({
  count: z.number(),
  sample: z.array(eventRefSchema),
  drilldown: z.object({ tool: z.literal('analytics_list_events'), args: z.record(z.string(), z.unknown()) }),
});
export type EventRefSummary = z.infer<typeof eventRefSummarySchema>;

// ---- analytics_balances (§6.1) ----------------------------------------------

export const tokenViewSchema = z.object({
  chain_id: z.number(),
  address: z.string().nullable(), // null = native
  symbol: z.string(), // sanitized *_display
  decimals: z.number(),
  is_stablecoin: z.boolean(),
  peg_currency: z.string().optional(), // present when is_stablecoin
  verified: z.boolean(),
  untrusted: z.object({ symbol_raw_sanitized: z.string() }).optional(), // only when symbol is empty
});
export type TokenView = z.infer<typeof tokenViewSchema>;

export const analyticsBalancesInput = z
  .object({
    scope: scopeSchema.optional(),
    chain_ids: z.array(z.number()).optional(),
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'as_of must be an ISO date (YYYY-MM-DD)').optional(),
    include_unverified: z.boolean().optional(),
    valuation: valuationSchema.optional(),
  })
  .strict();
export type AnalyticsBalancesInput = z.infer<typeof analyticsBalancesInput>;

export const analyticsBalancesOutput = z.object({
  as_of_effective: z.object({
    date: z.string(),
    per_chain: z.array(z.object({ chain_id: z.number(), block: z.number() })),
  }),
  balances: z.array(
    z.object({
      address: z.string(),
      chain_id: z.number(),
      token: tokenViewSchema,
      amount: decimalString,
      fiat_value: decimalString.optional(),
    }),
  ),
  totals: z.array(z.object({ currency: z.string(), value: decimalString })).optional(),
});
export type AnalyticsBalancesOutput = z.infer<typeof analyticsBalancesOutput>;

// ---- analytics_flows (§6.1) -------------------------------------------------

export const flowDirectionSchema = z.enum(['in', 'out', 'both']);
export type FlowDirection = z.infer<typeof flowDirectionSchema>;

/**
 * Grouping dimensions. `token` is always applied (raw amounts are per-token,
 * ADR-004); the others subdivide a token's flow. See 02-mcp-contracts §6.1.
 */
export const flowGroupBySchema = z.enum(['token', 'counterparty', 'day', 'month']);
export type FlowGroupBy = z.infer<typeof flowGroupBySchema>;

/** Restrict to a single token; `address: null` = native. */
export const tokenFilterSchema = z.object({ chain_id: z.number(), address: z.string().nullable() }).strict();
export type TokenFilter = z.infer<typeof tokenFilterSchema>;

export const analyticsFlowsInput = z
  .object({
    scope: scopeSchema.optional(),
    period: periodSchema,
    chain_ids: z.array(z.number()).optional(),
    direction: flowDirectionSchema.optional(),
    token: tokenFilterSchema.optional(),
    group_by: z.array(flowGroupBySchema).optional(),
    include_unverified: z.boolean().optional(),
    valuation: valuationSchema.optional(),
  })
  .strict();
export type AnalyticsFlowsInput = z.infer<typeof analyticsFlowsInput>;

/** One flow bucket. `group` carries the sanitized dimension labels (C6). */
export const flowRowSchema = z.object({
  group: z.record(z.string(), z.string()),
  inflow: decimalString,
  outflow: decimalString,
  net: decimalString,
  tx_count: z.number(),
  fiat: z.object({ inflow: decimalString, outflow: decimalString }).optional(),
});
export type FlowRowView = z.infer<typeof flowRowSchema>;

export const analyticsFlowsOutput = z.object({
  rows: z.array(flowRowSchema),
  internal_transfers: z.array(flowRowSchema),
});
export type AnalyticsFlowsOutput = z.infer<typeof analyticsFlowsOutput>;

// ---- analytics_gas (§6.1) ---------------------------------------------------

/**
 * Gas grouping. `chain` is implicit (the native fee token is per-chain, so rows
 * are always per-chain exactly as flow rows are always per-token, ADR-004);
 * `wallet`/`month` subdivide. See 02-mcp-contracts §6.1.
 */
export const gasGroupBySchema = z.enum(['wallet', 'chain', 'month']);
export type GasGroupBy = z.infer<typeof gasGroupBySchema>;

export const analyticsGasInput = z
  .object({
    scope: scopeSchema.optional(),
    period: periodSchema,
    chain_ids: z.array(z.number()).optional(),
    group_by: z.array(gasGroupBySchema).optional(),
    valuation: valuationSchema.optional(),
  })
  .strict();
export type AnalyticsGasInput = z.infer<typeof analyticsGasInput>;

/** One gas bucket. `group` always carries `chain`; `wallet`/`month` when grouped. */
export const gasRowSchema = z.object({
  group: z.record(z.string(), z.string()),
  native_amount: decimalString,
  tx_count: z.number(),
  fiat_value: decimalString.optional(),
});
export type GasRowView = z.infer<typeof gasRowSchema>;

export const analyticsGasOutput = z.object({ rows: z.array(gasRowSchema) });
export type AnalyticsGasOutput = z.infer<typeof analyticsGasOutput>;

// ---- analytics_stablecoin_movements (§6.1) ----------------------------------

/** Stablecoin flow grouping (no `day` — accountant question is monthly). */
export const stablecoinGroupBySchema = z.enum(['token', 'counterparty', 'month']);
export type StablecoinGroupBy = z.infer<typeof stablecoinGroupBySchema>;

export const analyticsStablecoinInput = z
  .object({
    scope: scopeSchema.optional(),
    period: periodSchema,
    peg_currency: z.enum(['USD', 'EUR']).optional(),
    group_by: z.array(stablecoinGroupBySchema).optional(),
  })
  .strict();
export type AnalyticsStablecoinInput = z.infer<typeof analyticsStablecoinInput>;

/**
 * Per-peg subtotal: face-value fiat sums over a peg's stablecoins, computed under
 * peg policy (each value pinned by a synthetic `source='peg'` price_ref, C4).
 * `inflow`/`outflow` are in `peg_currency`.
 */
export const pegSubtotalSchema = z.object({
  peg_currency: z.string(),
  inflow: decimalString,
  outflow: decimalString,
});
export type PegSubtotal = z.infer<typeof pegSubtotalSchema>;

export const analyticsStablecoinOutput = z.object({
  rows: z.array(flowRowSchema),
  internal_transfers: z.array(flowRowSchema),
  peg_subtotals: z.array(pegSubtotalSchema),
});
export type AnalyticsStablecoinOutput = z.infer<typeof analyticsStablecoinOutput>;

// ---- analytics_list_events (§6.1) -------------------------------------------

export const eventKindSchema = z.enum(['native_transfer', 'erc20_transfer', 'gas_fee', 'opening_balance']);
export type EventKindWire = z.infer<typeof eventKindSchema>;

/** A resolved endpoint; `entity` present only once the address book labels it. */
export const addressViewSchema = z.object({
  address: z.string(),
  entity: z.object({ entity_id: z.string(), name: z.string(), curated: z.boolean() }).optional(),
});
export type AddressView = z.infer<typeof addressViewSchema>;

export const analyticsListEventsInput = z
  .object({
    scope: scopeSchema.optional(),
    period: periodSchema.optional(),
    chain_ids: z.array(z.number()).optional(),
    tokens: z.array(tokenFilterSchema).optional(),
    counterparty_address: z.string().optional(),
    kinds: z.array(eventKindSchema).optional(),
    min_amount: nonNegativeDecimalString.optional(), // display units; non-negative (mirrors the ledger guard)
    include_unverified: z.boolean().optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export type AnalyticsListEventsInput = z.infer<typeof analyticsListEventsInput>;

export const eventListItemSchema = z.object({
  chain_id: z.number(),
  tx_hash: z.string(),
  log_index: z.number(),
  kind: eventKindSchema,
  block_number: z.number(),
  block_time: z.string(),
  token: tokenViewSchema,
  amount: decimalString,
  amount_raw: z.string(),
  from: addressViewSchema,
  to: addressViewSchema,
  direction: z.enum(['in', 'out', 'internal']),
});
export type EventListItemView = z.infer<typeof eventListItemSchema>;

export const analyticsListEventsOutput = z.object({
  events: z.array(eventListItemSchema),
  next_cursor: z.string().optional(),
  total_count: z.number().optional(), // first page only (cursor absent)
});
export type AnalyticsListEventsOutput = z.infer<typeof analyticsListEventsOutput>;

// ---- analytics_counterparties (§6.1) ----------------------------------------

/** Resolved counterparty label (address book, §6.3); `entity_kind` here, unlike AddressView. */
export const counterpartyEntitySchema = z.object({
  kind: z.literal('entity'),
  entity_id: z.string(),
  name: z.string(),
  entity_kind: z.string(),
  curated: z.boolean(),
});

/** Unlabeled counterparty — a bare address. */
export const counterpartyAddressSchema = z.object({
  kind: z.literal('address'),
  address: z.string(),
});

export const counterpartyRefSchema = z.discriminatedUnion('kind', [
  counterpartyEntitySchema,
  counterpartyAddressSchema,
]);
export type CounterpartyRef = z.infer<typeof counterpartyRefSchema>;

/**
 * Per-token turnover with a counterparty. Raw amounts are per token (base units of
 * different decimals are not summable, ADR-004); fiat is optional (valuation).
 */
export const counterpartyPerTokenSchema = z.object({
  token: tokenViewSchema,
  inflow: decimalString,
  outflow: decimalString,
  fiat: z.object({ inflow: decimalString, outflow: decimalString }).optional(),
});
export type CounterpartyPerTokenView = z.infer<typeof counterpartyPerTokenSchema>;

/**
 * One counterparty's turnover. `tx_count` is per counterparty (distinct txs), so it
 * does not partition across `per_token`; `fiat` (valuation only) is the summable
 * roll-up over `per_token` fiat.
 */
export const counterpartyRowSchema = z.object({
  counterparty: counterpartyRefSchema,
  tx_count: z.number(),
  tokens: z.array(z.string()), // sanitized symbols involved
  per_token: z.array(counterpartyPerTokenSchema),
  fiat: z.object({ inflow: decimalString, outflow: decimalString }).optional(),
});
export type CounterpartyRowView = z.infer<typeof counterpartyRowSchema>;

export const analyticsCounterpartiesInput = z
  .object({
    scope: scopeSchema.optional(),
    period: periodSchema,
    chain_ids: z.array(z.number()).optional(),
    direction: flowDirectionSchema.optional(),
    top_n: z.number().int().positive().optional(), // counterparties, not rows
    include_unverified: z.boolean().optional(),
    valuation: valuationSchema.optional(),
  })
  .strict();
export type AnalyticsCounterpartiesInput = z.infer<typeof analyticsCounterpartiesInput>;

export const analyticsCounterpartiesOutput = z.object({
  rows: z.array(counterpartyRowSchema),
  unlabeled_share: z.object({
    tx_count: z.number(),
    hint: z.literal('directory_upsert_entity'),
  }),
});
export type AnalyticsCounterpartiesOutput = z.infer<typeof analyticsCounterpartiesOutput>;

// ---- directory_* (§6.3) -----------------------------------------------------

/** Entity kinds (mirrors the `entities.kind` CHECK, schema.sql). */
export const directoryEntityKind = z.enum([
  'self', 'client', 'vendor', 'exchange', 'contract', 'employee', 'other',
]);
export type DirectoryEntityKind = z.infer<typeof directoryEntityKind>;

export const directoryListEntitiesInput = z
  .object({
    query: z.string().optional(),
    kind: z.string().optional(),
    address: z.string().optional(),
  })
  .strict();
export type DirectoryListEntitiesInput = z.infer<typeof directoryListEntitiesInput>;

export const directoryEntityViewSchema = z.object({
  entity_id: z.string(),
  name: z.string(),
  kind: z.string(),
  curated: z.boolean(),
  addresses: z.array(z.object({ chain_id: z.number().nullable(), address: z.string() })),
  notes: z.string().optional(),
});
export type DirectoryEntityView = z.infer<typeof directoryEntityViewSchema>;

export const directoryListEntitiesOutput = z.object({
  entities: z.array(directoryEntityViewSchema),
});
export type DirectoryListEntitiesOutput = z.infer<typeof directoryListEntitiesOutput>;

export const directoryUpsertEntityInput = z
  .object({
    entity_id: z.string().optional(), // present = update
    name: z.string(),
    kind: directoryEntityKind,
    client_id: z.string().optional(),
    notes: z.string().optional(),
    addresses: z.array(z.object({ chain_id: z.number().optional(), address: z.string() })).optional(),
  })
  .strict();
export type DirectoryUpsertEntityInput = z.infer<typeof directoryUpsertEntityInput>;

export const directoryUpsertEntityOutput = z.object({
  entity_id: z.string(),
  created: z.boolean(),
});
export type DirectoryUpsertEntityOutput = z.infer<typeof directoryUpsertEntityOutput>;

// ---- ledger_* (§6.2) --------------------------------------------------------

export const ledgerStatusInput = z.object({ scope: scopeSchema.optional() }).strict();
export type LedgerStatusInput = z.infer<typeof ledgerStatusInput>;

/** Per-stream freshness. `status` mirrors the checkpoint enum but is typed as a
 *  free string on the wire (contract §6.2). `last_block_time` is absent for a
 *  freshly-queued stream that has no ingested events yet. */
export const ledgerStreamStatusSchema = z.object({
  stream: z.enum(['native', 'erc20']),
  status: z.string(),
  last_processed_block: z.number(),
  last_block_time: z.string().optional(),
  anchor_block: z.number().optional(),
  backfill_progress: z.number().optional(), // 0..1 estimate; omitted when unknown
  last_error: z.string().optional(),
});
export type LedgerStreamStatusView = z.infer<typeof ledgerStreamStatusSchema>;

/** Balance-vs-provider drift check (ADR-005 decision 4); `clean` is derived
 *  `drifts.length === 0`. Amounts are decimal strings (ADR-004). */
export const ledgerIntegritySchema = z.object({
  checked_at: z.string(),
  block: z.number(),
  clean: z.boolean(),
  drifts: z.array(z.object({ token: z.string(), computed: decimalString, provider: decimalString })),
});

export const ledgerWalletStatusSchema = z.object({
  address: z.string(),
  chain_id: z.number(),
  streams: z.array(ledgerStreamStatusSchema),
  integrity: ledgerIntegritySchema.optional(),
  // >50k probe estimate (ADR-008 Q5), populated asynchronously by the worker.
  // `suggests_anchored` is the HITL nudge to re-track in anchored mode.
  estimate: z.object({ tx_count_hint: z.number(), suggests_anchored: z.boolean() }).optional(),
});
export type LedgerWalletStatusView = z.infer<typeof ledgerWalletStatusSchema>;

export const ledgerStatusOutput = z.object({ wallets: z.array(ledgerWalletStatusSchema) });
export type LedgerStatusOutput = z.infer<typeof ledgerStatusOutput>;

export const ledgerTrackWalletInput = z
  .object({
    address: z.string(),
    chains: z.array(z.number()).optional(), // default: all enabled chains
    client_id: z.string().optional(),
    label: z.string().optional(),
    mode: z.enum(['full', 'anchored']).optional(), // default 'full' (ADR-008)
    anchored_from: isoDateString.optional(), // required when mode='anchored'
  })
  .strict()
  // F4 (ADR-008): anchored mode needs a real, past baseline date. The worker
  // resolves anchored_from → a block via getBlockByTime, so a missing/future/
  // non-calendar date must fail closed here rather than mis-anchor downstream.
  .superRefine((v, ctx) => {
    if (v.mode === 'anchored' && v.anchored_from === undefined) {
      ctx.addIssue({ code: 'custom', path: ['anchored_from'], message: "anchored_from is required when mode='anchored'" });
    }
    if (v.anchored_from !== undefined) {
      const [y, m, d] = v.anchored_from.split('-').map(Number) as [number, number, number];
      const parsed = new Date(Date.UTC(y, m - 1, d));
      const real = parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
      if (!real) {
        ctx.addIssue({ code: 'custom', path: ['anchored_from'], message: 'anchored_from is not a valid calendar date' });
      } else if (parsed.getTime() > Date.now()) {
        ctx.addIssue({ code: 'custom', path: ['anchored_from'], message: 'anchored_from must not be in the future' });
      }
    }
  });
export type LedgerTrackWalletInput = z.infer<typeof ledgerTrackWalletInput>;

export const ledgerTrackWalletOutput = z.object({
  wallet_id: z.string(),
  enqueued: z.array(z.object({ chain_id: z.number(), stream: z.string(), job_id: z.string() })),
  // NB: the >50k probe estimate is NOT returned here — it runs asynchronously
  // worker-side and surfaces on `ledger_status` (02-mcp-contracts §6.2, ADR-008).
});
export type LedgerTrackWalletOutput = z.infer<typeof ledgerTrackWalletOutput>;

export const ledgerTraceToolCallInput = z.object({ tool_call_id: z.string() }).strict();
export type LedgerTraceToolCallInput = z.infer<typeof ledgerTraceToolCallInput>;

export const ledgerTraceToolCallOutput = z.object({
  tool_name: z.string(),
  args: z.record(z.string(), z.unknown()),
  called_at: z.string(),
  coverage: z.array(coverageRefSchema),
  result_digest: z.string(),
  drilldown: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }).optional(),
});
export type LedgerTraceToolCallOutput = z.infer<typeof ledgerTraceToolCallOutput>;

// ---- export_* (§6.5) --------------------------------------------------------

/** The four persisted export artifact kinds (mirrors the `exports.kind` CHECK, schema.sql). */
export const exportKindSchema = z.enum(['close_pack', 'pdf_summary', 'journal_qbo', 'journal_xero']);
export type ExportKind = z.infer<typeof exportKindSchema>;

/** Accounting month on the wire (UTC calendar month); the close period is the whole month.
 *  Month is range-checked (01–12) so an impossible month fails as INVALID_INPUT rather than
 *  flowing into date math and surfacing as an opaque INTERNAL. */
export const monthString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month (YYYY-MM)');

/** The resolved [start, end] ISO dates the export actually covered (echoed back, citable). */
export const exportPeriodSchema = z.object({ start: isoDateString, end: isoDateString }).strict();
export type ExportPeriod = z.infer<typeof exportPeriodSchema>;

/** One materialized artifact: its bundle-relative name, absolute path on disk, content hash. */
export const exportFileSchema = z.object({
  name: z.string(),
  path: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha256 hex digest'),
}).strict();
export type ExportFileView = z.infer<typeof exportFileSchema>;

/**
 * `export_close_pack` (contract §6.5) — monthly close bundle (6 CSVs + manifest).
 * Non-read-only (writes files, registers an `exports` row) but never destructive.
 * `valuation` is required: the pack values balances/flows and derives a journal draft.
 */
export const exportClosePackInput = z
  .object({
    month: monthString,
    scope: scopeSchema.optional(),
    client_id: z.string().optional(),
    valuation: valuationSchema,
    out_dir: z.string().optional(),
  })
  .strict();
export type ExportClosePackInput = z.infer<typeof exportClosePackInput>;

export const exportClosePackOutput = z
  .object({
    export_id: z.string(),
    kind: z.literal('close_pack'),
    period: exportPeriodSchema,
    files: z.array(exportFileSchema),
  })
  .strict();
export type ExportClosePackOutput = z.infer<typeof exportClosePackOutput>;

/** `export_pdf_summary` (contract §6.5) — one-page PDF summary + manifest. Same input shape. */
export const exportPdfSummaryInput = z
  .object({
    month: monthString,
    scope: scopeSchema.optional(),
    client_id: z.string().optional(),
    valuation: valuationSchema,
    out_dir: z.string().optional(),
  })
  .strict();
export type ExportPdfSummaryInput = z.infer<typeof exportPdfSummaryInput>;

export const exportPdfSummaryOutput = z
  .object({
    export_id: z.string(),
    kind: z.literal('pdf_summary'),
    period: exportPeriodSchema,
    files: z.array(exportFileSchema),
  })
  .strict();
export type ExportPdfSummaryOutput = z.infer<typeof exportPdfSummaryOutput>;

/**
 * `export_journal_drafts` (contract §6.5) — a QBO/Xero manual-journal CSV DRAFT built
 * from CONFIRMED matches only (P8). No `valuation`: the journal values from each
 * confirmed leg's pinned fiat (face value, P5). `account_mapping` maps our line
 * categories (crypto_asset / accounts_receivable / accounts_payable / vat_output /
 * vat_input / rounding) to the caller's chart-of-accounts codes; unmapped-but-present
 * categories come back in `unmapped_categories`. `balanced` is a guarantee by
 * construction: every entry is internally balanced, no rounding line is ever appended,
 * and a non-zero per-currency residue fails the export (invariant violation).
 */
export const exportJournalDraftsInput = z
  .object({
    period: periodSchema,
    target: z.enum(['qbo', 'xero']),
    client_id: z.string().optional(),
    account_mapping: z.record(z.string(), z.string()).optional(),
    out_dir: z.string().optional(),
  })
  .strict();
export type ExportJournalDraftsInput = z.infer<typeof exportJournalDraftsInput>;

export const exportJournalDraftsOutput = z
  .object({
    export_id: z.string(),
    file: exportFileSchema,
    lines: z.number().int().nonnegative(),
    unmapped_categories: z.array(z.string()),
    balanced: z.literal(true),
  })
  .strict();
export type ExportJournalDraftsOutput = z.infer<typeof exportJournalDraftsOutput>;

// ---- recon_* (§6.4, Face B) -------------------------------------------------

/** Direction of an external record (mirrors the `external_records.direction` CHECK). */
export const externalRecordDirection = z.enum(['receivable', 'payable']);
export type ExternalRecordDirection = z.infer<typeof externalRecordDirection>;

/**
 * `recon_import_invoices` (contract §6.4, write, idempotent) — CSV invoice import.
 * Exactly one of `content` (inline, capped) / `file_path` (self-host mount). Column
 * `mapping` (CSV column → canonical field) overrides auto-detection. `vat_rate` is a
 * rate, not money, so it rides as a number; invoice amounts never do (ADR-004).
 */
export const reconImportInvoicesInput = z
  .object({
    format: z.literal('csv'),
    content: z.string().optional(),
    file_path: z.string().optional(),
    client_id: z.string().optional(),
    mapping: z.record(z.string(), z.string()).optional(),
    defaults: z
      .object({
        currency: z.string().optional(),
        direction: externalRecordDirection.optional(),
        // Non-negative: a negative default would poison every row that relies on it
        // (INVALID_VAT), so fail fast at input validation instead.
        vat_rate: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.content === undefined) === (v.file_path === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'exactly one of `content` or `file_path` is required' });
    }
    // Inline content is capped (contract: ≤ 1 MB); larger imports use file_path on
    // the self-host mount. Character length is a sufficient guard here.
    if (v.content !== undefined && v.content.length > 1_000_000) {
      ctx.addIssue({ code: 'custom', path: ['content'], message: 'inline `content` exceeds 1 MB; use `file_path`' });
    }
  });
export type ReconImportInvoicesInput = z.infer<typeof reconImportInvoicesInput>;

/** One imported record echoed back. `counterparty_name` is hostile import text, so
 *  it appears only sanitized, under the `untrusted` key (C6, ADR-011). */
export const reconImportedRecordSchema = z.object({
  id: z.string(),
  external_ref: z.string(),
  amount: decimalString,
  currency: z.string(),
  issued_on: z.string().optional(),
  untrusted: z.object({ counterparty_name: z.string() }).optional(),
});
export type ReconImportedRecordView = z.infer<typeof reconImportedRecordSchema>;

export const reconImportInvoicesOutput = z
  .object({
    inserted: z.number().int().nonnegative(),
    skipped_duplicates: z.number().int().nonnegative(),
    errors: z.array(z.object({ row: z.number().int(), code: z.string(), message: z.string() })),
    records: z.array(reconImportedRecordSchema),
  })
  .strict();
export type ReconImportInvoicesOutput = z.infer<typeof reconImportInvoicesOutput>;

// ---- recon_suggest_matches (§6.4, ADR-010) ----------------------------------

/**
 * Match tolerances (contract §6.4). All optional; the engine applies the defaults
 * (amount_pct 1.0, date_window_days 14). `amount_pct` is a percent, not money, so it
 * rides as a number; `amount_abs` is money and stays a decimal string (ADR-004).
 * `amount_pct` resolves to 4 decimal places (e.g. `0.0001`); precision finer than
 * that still rounds — a documented contract, never an error (ADR-010 A6).
 * `date_window_days` caps at 3650 (10y): unbounded input (e.g. `1e15`) overflows
 * `Date` arithmetic in match-repo.ts into `Invalid Date`, which otherwise surfaces
 * as an opaque INTERNAL rather than a clean INVALID_INPUT (C9).
 */
export const reconTolerancesSchema = z
  .object({
    amount_pct: z.number().nonnegative().optional(),
    amount_abs: nonNegativeDecimalString.optional(), // in the record's currency
    date_window_days: z.number().int().nonnegative().max(3650).optional(),
  })
  .strict();
export type ReconTolerances = z.infer<typeof reconTolerancesSchema>;

export const reconSuggestMatchesInput = z
  .object({
    period: periodSchema.optional(),
    client_id: z.string().optional(),
    record_ids: z.array(z.string()).optional(),
    tolerances: reconTolerancesSchema.optional(),
  })
  .strict();
export type ReconSuggestMatchesInput = z.infer<typeof reconSuggestMatchesInput>;

/** One rule hit explaining a suggestion; `weight` is the rule's contribution, so
 *  Σ weights === confidence — the score is reproducible from the rationale (P1). */
export const matchRationaleSchema = z.object({
  rule: z.string(),
  weight: z.number(),
  detail: z.string(),
});
export type MatchRationaleView = z.infer<typeof matchRationaleSchema>;

/** The settlement event carried on a suggestion: an EventRef plus display fields. */
export const matchEventViewSchema = z.object({
  chain_id: z.number(),
  tx_hash: z.string(),
  log_index: z.number(),
  token: tokenViewSchema,
  amount: decimalString,
  block_time: z.string(),
  from: addressViewSchema,
});
export type MatchEventView = z.infer<typeof matchEventViewSchema>;

/** One suggested leg on the wire (a persisted `matches` row, status='suggested'). */
export const matchSuggestionSchema = z.object({
  match_id: z.string(),
  record: z.object({
    id: z.string(),
    external_ref: z.string(),
    amount: decimalString,
    currency: z.string(),
    open_amount: decimalString,
  }),
  event: matchEventViewSchema,
  amount_applied: decimalString,
  fiat_value: decimalString,
  confidence: z.number(),
  rationale: z.array(matchRationaleSchema),
});
export type MatchSuggestionView = z.infer<typeof matchSuggestionSchema>;

export const reconSuggestMatchesOutput = z
  .object({
    suggestions: z.array(matchSuggestionSchema),
    unmatched_records: z.number().int().nonnegative(),
    unmatched_settlements: z.number().int().nonnegative(),
  })
  .strict();
export type ReconSuggestMatchesOutput = z.infer<typeof reconSuggestMatchesOutput>;

// ---- recon_confirm_match / recon_reject_match (§6.4, write, HITL) -----------

/**
 * Both HITL decision tools share one input: the `matches` row id plus an optional
 * free-text note (audited via the tool_call, not stored on the row). Exported under
 * both tool names so the registry references a schema per tool.
 */
const matchDecisionInput = z.object({ match_id: z.string(), note: z.string().optional() }).strict();
export const reconConfirmMatchInput = matchDecisionInput;
export const reconRejectMatchInput = matchDecisionInput;
export type ReconMatchDecisionInput = z.infer<typeof matchDecisionInput>;

/**
 * Valuation of the actioned leg. `fiat_value` is always present; `price_ref`/`fx_ref`
 * are pinned only when a non-stablecoin snapshot backs the value (C4 "priced means
 * pinned") — omitted for the stablecoin face-value path.
 */
export const matchValuationSchema = z
  .object({
    fiat_value: decimalString,
    price_ref: priceRefSchema.optional(),
    fx_ref: fxRefSchema.optional(),
  })
  .strict();
export type MatchValuationView = z.infer<typeof matchValuationSchema>;

/** Output of a confirm/reject: the new leg status and the freshly derived record status. */
const matchDecisionOutput = z
  .object({
    match_id: z.string(),
    status: z.enum(['confirmed', 'rejected']),
    record_status: z.enum(['open', 'partially_matched', 'matched', 'overpaid']),
    valuation: matchValuationSchema,
  })
  .strict();
export const reconConfirmMatchOutput = matchDecisionOutput;
export const reconRejectMatchOutput = matchDecisionOutput;
export type ReconMatchDecisionOutput = z.infer<typeof matchDecisionOutput>;

// ---- recon_status (§6.4, read) ----------------------------------------------

/** Filters for the reconciliation snapshot: an optional period and client scope. */
export const reconStatusInput = z
  .object({
    period: periodSchema.optional(),
    client_id: z.string().optional(),
  })
  .strict();
export type ReconStatusInput = z.infer<typeof reconStatusInput>;

/** Record tallies per lifecycle state; every state is always present (0 when empty). */
const recordStatusCountsSchema = z
  .object({
    open: z.number().int().nonnegative(),
    partially_matched: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    overpaid: z.number().int().nonnegative(),
    void: z.number().int().nonnegative(),
  })
  .strict();
export type RecordStatusCounts = z.infer<typeof recordStatusCountsSchema>;

/**
 * The authoritative reconciliation snapshot (§6.4). `unmatched_settlements` reuses the
 * shared `event_ref_summary` shape (count + sample EventRefs + an executable
 * `analytics_list_events` drilldown), so the settlement figure is self-citing (C3).
 * `open_amounts` are outstanding (amount − confirmed) per currency over open/partial
 * records; `overpayments` carry the excess (confirmed − amount) per overpaid record.
 */
export const reconStatusOutput = z
  .object({
    records: recordStatusCountsSchema,
    open_amounts: z.array(z.object({ currency: z.string(), value: decimalString }).strict()),
    unmatched_settlements: eventRefSummarySchema,
    overpayments: z.array(
      z
        .object({
          record_id: z.string(),
          external_ref: z.string(),
          excess: decimalString,
          currency: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type ReconStatusOutput = z.infer<typeof reconStatusOutput>;
