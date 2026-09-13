/**
 * Thin CLI agent (P11): the demo REPL + the eval runner, built on the Anthropic SDK
 * Tool Runner (04-testing.md §5). Tools are bound in-process from @reconcil/mcp-tools —
 * no server process in the loop (ADR-012). The Anthropic API key is needed only here
 * and in the eval harness, never by the server or worker.
 *
 * `evals run` lives in `run.ts` (also wired as the `evals` package script); `repl` starts
 * the interactive demo agent (`repl.ts`). The shared prompt + tool binding live in
 * `agent/core.ts`. Both commands below delegate to the exact same entrypoint the package
 * scripts use — `main.ts` is a thin argv router, not a second implementation.
 */
import { DEFAULT_MODEL } from './model.js';

const usage = `reconcil CLI

Commands:
  evals        run the eval suite + demo gate (04-testing.md §5/§6)
                 pnpm --filter @reconcil/cli evals -- --suite core --runs 3
                 pnpm --filter @reconcil/cli evals -- --smoke        # 6 cases × 1 run
               flags: --model <id> (default ${DEFAULT_MODEL}), --out <dir>
               needs ANTHROPIC_API_KEY; DATABASE_URL or Docker (testcontainers).
  repl         interactive demo agent over the tenant's tracked wallets
                 pnpm --filter @reconcil/cli dev repl
               flags: --model <id> (default ${DEFAULT_MODEL})
               needs ANTHROPIC_API_KEY + DATABASE_URL (a running stack).
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'repl') {
    const { runRepl } = await import('./repl.js');
    await runRepl();
  } else if (command === 'evals') {
    const { runEvals } = await import('./run.js');
    await runEvals(process.argv.slice(3));
  } else {
    console.log(usage);
  }
}

main().catch(async (err: unknown) => {
  // Labelled 'cli', not 'eval gate': this catch sees `repl` too, and the eval vocabulary
  // ("so no case ever ran", "re-run the job") is wrong for a command that runs no cases in
  // no job. The classification itself is shared — a rejected key is a rejected key.
  // Imported HERE, on the failure path only. runnability.ts pulls in @anthropic-ai/sdk at
  // top level, and a static import re-created exactly what splitting UsageError out was
  // meant to stop: `reconcil` with no arguments loading the whole SDK graph to print a
  // usage string. The docstring in usage-error.ts states that property; this keeps it true.
  const { reportFailure } = await import('./evals/runnability.js');
  await reportFailure('cli', err);
});
