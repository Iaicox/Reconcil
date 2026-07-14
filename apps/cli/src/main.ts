/**
 * Thin CLI agent (P11): demo REPL + `evals run`, built on the Agent SDK in
 * weeks 4–5. Tools are bound in-process from @pet-crypto/mcp-tools — no
 * server process in the eval loop (ADR-012). The Anthropic API key is needed
 * only here and in the eval harness, never by the server or worker.
 */
const usage = `pet-crypto CLI — not implemented yet (weeks 4–5).

Planned commands:
  repl         interactive demo agent
  evals run    run the eval suite (docs/architecture/04-testing.md §5)
`;

console.log(usage);
