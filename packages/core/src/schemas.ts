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

// ---- shared inputs (§5) -----------------------------------------------------

export const scopeSchema = z
  .object({
    wallet_ids: z.array(z.string()).optional(),
    client_id: z.string().optional(),
    addresses: z.array(z.string()).optional(),
  })
  .strict();
export type Scope = z.infer<typeof scopeSchema>;

export const periodSchema = z.object({ from: z.string(), to: z.string() }).strict();
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
  verified: z.boolean(),
  untrusted: z.object({ symbol_raw_sanitized: z.string() }).optional(), // only when symbol is empty
});
export type TokenView = z.infer<typeof tokenViewSchema>;

export const analyticsBalancesInput = z
  .object({
    scope: scopeSchema.optional(),
    chain_ids: z.array(z.number()).optional(),
    as_of: z.string().optional(), // ISO date (UTC)
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
