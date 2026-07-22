/**
 * Transport-agnostic MCP tool implementations (02-mcp-contracts). Each tool is a
 * `(ctx, input)` handler returning a citation envelope; the server/cli/evals
 * register these objects against their transport. Tenant identity is injected via
 * `ToolContext`, never read from arguments (ADR-006/012).
 */
import { analyticsBalancesInput, analyticsFlowsInput } from '@pet-crypto/core';
import { z } from 'zod';

import type { ToolContext } from './context.js';
import type { ToolEnvelope } from './envelope.js';
import { analyticsBalances, TOOL_NAME as BALANCES_TOOL } from './tools/analytics-balances.js';
import { analyticsFlows, TOOL_NAME as FLOWS_TOOL } from './tools/analytics-flows.js';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

/** Every tool is a `(ctx, input) → envelope` handler; the data payload is tool-specific. */
export type ToolHandler = (ctx: ToolContext, input: unknown) => Promise<ToolEnvelope<unknown>>;

export interface ToolDescriptor {
  name: string;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>; // JSON Schema, published in the MCP declaration
  handler: ToolHandler;
}

/** All analytics_* tools are read-only (P8), never destructive. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };

export const analyticsBalancesTool: ToolDescriptor = {
  name: BALANCES_TOOL,
  annotations: READ_ONLY,
  inputSchema: z.toJSONSchema(analyticsBalancesInput) as Record<string, unknown>,
  handler: analyticsBalances,
};

export const analyticsFlowsTool: ToolDescriptor = {
  name: FLOWS_TOOL,
  annotations: READ_ONLY,
  inputSchema: z.toJSONSchema(analyticsFlowsInput) as Record<string, unknown>,
  handler: analyticsFlows,
};

/** The registry the server/cli/evals iterate to declare tools. */
export const tools: ToolDescriptor[] = [analyticsBalancesTool, analyticsFlowsTool];

export { analyticsBalances } from './tools/analytics-balances.js';
export { analyticsFlows } from './tools/analytics-flows.js';
export { buildEnvelope, type ToolEnvelope, type Citations, type EnvelopeParts } from './envelope.js';
export { resolveScope, type ResolvedScope } from './scope.js';
export { persistToolCall, canonicalStringify, type PersistParams } from './tool-calls.js';
export { mapCoverage } from './coverage.js';
export { toTokenView } from './token-view.js';
export { selectRefs, dedupeRefs, REF_CAP } from './refs.js';
export { ulid } from './ulid.js';
export { ToolError, type ErrorCode } from './errors.js';
export type { ToolContext } from './context.js';
