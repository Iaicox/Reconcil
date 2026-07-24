/**
 * Thin CLI agent (P11): the demo REPL + the eval runner, built on the Anthropic SDK
 * Tool Runner (04-testing.md §5). Tools are bound in-process from @pet-crypto/mcp-tools —
 * no server process in the eval loop (ADR-012). The Anthropic API key is needed only here
 * and in the eval harness, never by the server or worker.
 *
 * `evals run` lives in `run.ts` (the `evals` package script); the demo REPL is the next
 * slice. This entry documents the surface and points at the runner.
 */
const usage = `pet-crypto CLI

Commands:
  evals        run the eval suite + demo gate (04-testing.md §5/§6)
                 pnpm --filter @pet-crypto/cli evals -- --suite core --runs 3
                 pnpm --filter @pet-crypto/cli evals -- --smoke        # 5 cases × 1 run
               flags: --model <id> (default claude-opus-4-8), --out <dir>
               needs ANTHROPIC_API_KEY; DATABASE_URL or Docker (testcontainers).
  repl         interactive demo agent — not implemented yet (next slice).
`;

const command = process.argv[2];
if (command === 'evals') {
  console.log('Run the eval suite via the package script:\n  pnpm --filter @pet-crypto/cli evals -- --suite core');
} else {
  console.log(usage);
}
