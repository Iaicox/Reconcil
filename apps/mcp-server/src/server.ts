import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { serializeError, type Logger } from '@pet-crypto/core';
import { tools, ToolError, type ToolContext } from '@pet-crypto/mcp-tools';

import { describeTool } from './descriptions.js';
import { renderEnvelope } from './render.js';

interface ErrorPayload {
  code: string;
  message: string;
  hint?: string;
}

/** Domain/validation failure → MCP tool-error result with a structured, actionable payload (contract §4). */
function errorResult(payload: ErrorPayload): CallToolResult {
  const structured: Record<string, unknown> = { code: payload.code, message: payload.message };
  if (payload.hint !== undefined) structured['hint'] = payload.hint;
  return {
    isError: true,
    structuredContent: structured,
    content: [{ type: 'text', text: JSON.stringify(structured) }],
  };
}

/**
 * One tool registry, two transports (ADR-012): stdio.ts and http.ts both build a
 * server here. This is a thin adapter — the tools in @pet-crypto/mcp-tools
 * self-validate input, build+validate their envelope, and persist the tool_call
 * before returning (C2); the server only maps transport ↔ registry and shapes
 * errors. `makeContext` supplies the per-call ToolContext: a fixed self-host
 * tenant for stdio, the bearer-resolved tenant for each HTTP request. The pg Pool
 * behind `ctx.db` is long-lived and shared through the closure.
 */
export function createServer(makeContext: () => ToolContext, logger?: Logger): Server {
  const server = new Server(
    { name: 'pet-crypto', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map<Tool>((t) => ({
      name: t.name,
      description: describeTool(t.name),
      // JSON Schema is generated once from the core Zod schema (z.toJSONSchema) and
      // published verbatim; its runtime shape is `{ type: 'object', ... }`.
      inputSchema: t.inputSchema as unknown as Tool['inputSchema'],
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const descriptor = tools.find((t) => t.name === name);
    if (descriptor === undefined) {
      return errorResult({ code: 'INVALID_INPUT', message: `Unknown tool: ${name}` });
    }
    try {
      const envelope = await descriptor.handler(makeContext(), args ?? {});
      return {
        // ToolEnvelope is a plain object graph; the cast only satisfies the SDK's
        // Record<string, unknown> structuredContent type.
        structuredContent: envelope as unknown as Record<string, unknown>,
        content: [{ type: 'text', text: renderEnvelope(envelope) }],
      };
    } catch (err) {
      if (err instanceof ToolError) {
        return errorResult({
          code: err.code,
          message: err.message,
          ...(err.hint !== undefined ? { hint: err.hint } : {}),
        });
      }
      // Never surface err.cause (hostile provider/chain text, ADR-011): log the
      // scrubbed shape only, return an opaque INTERNAL to the agent.
      logger?.error('tool call failed', { tool: name, err: serializeError(err) });
      return errorResult({ code: 'INTERNAL', message: 'Internal error' });
    }
  });

  return server;
}
