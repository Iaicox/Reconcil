/**
 * Domain/validation failures surfaced to the agent as MCP tool errors
 * (isError:true) with a structured, actionable payload (contract §4). Transport
 * errors (auth, JSON-RPC) are the server's concern and never carry domain detail.
 */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'WALLET_NOT_TRACKED'
  | 'UNKNOWN_SCOPE'
  | 'COVERAGE_EMPTY'
  | 'PERIOD_TOO_LARGE'
  | 'MATCH_CONFLICT'
  | 'NOT_SUGGESTED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}
