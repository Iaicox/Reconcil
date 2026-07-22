/**
 * Transport-agnostic MCP tool implementations (02-mcp-contracts). Each tool is a
 * `(ctx, input)` handler returning a citation envelope; the server/cli/evals
 * register these objects against their transport. Tenant identity is injected via
 * `ToolContext`, never read from arguments (ADR-006/012).
 */
import { analyticsBalancesInput } from '@pet-crypto/core';
import { z } from 'zod';

import { analyticsBalances, TOOL_NAME } from './tools/analytics-balances.js';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

export interface ToolDescriptor {
  name: string;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>; // JSON Schema, published in the MCP declaration
  handler: typeof analyticsBalances;
}

/** `analytics_balances` — read-only (P8), never destructive. */
export const analyticsBalancesTool: ToolDescriptor = {
  name: TOOL_NAME,
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: z.toJSONSchema(analyticsBalancesInput) as Record<string, unknown>,
  handler: analyticsBalances,
};

export { analyticsBalances, TOOL_NAME } from './tools/analytics-balances.js';
export { buildEnvelope, type ToolEnvelope, type Citations, type EnvelopeParts } from './envelope.js';
export { resolveScope, type ResolvedScope } from './scope.js';
export { persistToolCall, canonicalStringify, type PersistParams } from './tool-calls.js';
export { ulid } from './ulid.js';
export { ToolError, type ErrorCode } from './errors.js';
export type { ToolContext } from './context.js';
