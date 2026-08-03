/**
 * Thin CLI agent (P11): the demo REPL + the eval runner, built on the Anthropic SDK
 * Tool Runner (04-testing.md §5). Tools are bound in-process from @reconcil/mcp-tools —
 * no server process in the loop (ADR-012). The Anthropic API key is needed only here
 * and in the eval harness, never by the server or worker.
 *
 * `evals run` lives in `run.ts` (the `evals` package script); `repl` starts the
 * interactive demo agent (`repl.ts`). The shared prompt + tool binding live in `agent/core.ts`.
 */
const usage = `reconcil CLI

Commands:
  evals        run the eval suite + demo gate (04-testing.md §5/§6)
                 pnpm --filter @reconcil/cli evals -- --suite core --runs 3
                 pnpm --filter @reconcil/cli evals -- --smoke        # 6 cases × 1 run
               flags: --model <id> (default claude-opus-4-8), --out <dir>
               needs ANTHROPIC_API_KEY; DATABASE_URL or Docker (testcontainers).
  repl         interactive demo agent over the tenant's tracked wallets
                 pnpm --filter @reconcil/cli dev repl
               flags: --model <id> (default claude-opus-4-8)
               needs ANTHROPIC_API_KEY + DATABASE_URL (a running stack).
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'repl') {
    const { runRepl } = await import('./repl.js');
    await runRepl();
  } else if (command === 'evals') {
    console.log('Run the eval suite via the package script:\n  pnpm --filter @reconcil/cli evals -- --suite core');
  } else {
    console.log(usage);
  }
}

main().catch((err: unknown) => {
  console.error('cli failed:', err);
  process.exit(1);
});
