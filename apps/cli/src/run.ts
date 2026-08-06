/**
 * `evals run` entry (04-testing.md §5/§6): seed a fixture DB, run the Agent Tool Runner
 * over the dataset, grade deterministically, apply the demo-readiness gate, and write a
 * JSON + Markdown scorecard. Exits non-zero when the gate fails so CI blocks the demo.
 *
 * DB: `DATABASE_URL` if set, else a throwaway testcontainers Postgres (needs Docker).
 * The Anthropic API key is read from `ANTHROPIC_API_KEY` (the only place it is needed).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { createDb, runMigrations, type Db } from '@reconcil/db';
import { loadDataset } from '@reconcil/evals';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

import { DATASETS, parseArgs } from './evals/args.js';
import { makeAgentProducer } from './evals/agent.js';
import { withTempExportDir } from './evals/export-dir.js';
import { evaluateGate } from './evals/gate.js';
import { runSuite } from './evals/harness.js';
import { dbResolver } from './evals/resolver.js';
import { buildReport, toJson, toMarkdown } from './evals/scorecard.js';
import { makeSeedCase } from './evals/seed-case.js';
import { SMOKE_IDS, selectSmokeDataset } from './evals/smoke.js';
import { METRICS } from './evals/types.js';

/** DATABASE_URL if provided, else a throwaway container. Returns db + a disposer. */
async function provisionDb(): Promise<{ db: Db; dispose: () => Promise<void> }> {
  const url = process.env['DATABASE_URL'];
  if (url !== undefined && url !== '') {
    const pool = new Pool({ connectionString: url });
    // If migrations throw, close the pool before rethrowing — nothing owns it yet.
    try {
      await runMigrations(pool);
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
    return { db: createDb(pool), dispose: () => pool.end() };
  }
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  // The disposer isn't returned yet, so a migration failure here would orphan the
  // container — tear both down before rethrowing.
  try {
    await runMigrations(pool);
  } catch (err) {
    await pool.end().catch(() => {});
    await container.stop().catch(() => {});
    throw err;
  }
  return {
    db: createDb(pool),
    dispose: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

/**
 * `evals run`, callable either as a standalone script (`tsx src/run.ts …`, argv defaults to
 * `process.argv.slice(2)`) or delegated to from `main.ts`'s `evals` command (which passes
 * its own remaining argv explicitly).
 */
export async function runEvals(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('ANTHROPIC_API_KEY is required to run the eval agent (the only place it is needed).');
    process.exitCode = 1;
    return;
  }

  // parseArgs validated args.suite is a known DATASETS key.
  const all = loadDataset(DATASETS[args.suite]!());
  // H16: assert the smoke filter matched every SMOKE_ID before any container/provisioning
  // work (fail fast, cheap) — a renamed/removed id must fail loudly, not silently shrink the
  // live PR gate (or, if all six drift, run ZERO cases and report PASS).
  const dataset = args.smoke ? selectSmokeDataset(all, SMOKE_IDS) : all;

  // Route recon-backed exports (a Face B journal-draft case's export_journal_drafts) to a
  // throwaway dir instead of cwd/exports (baseDir default). withTempExportDir owns creation
  // AND cleanup, including the case where DB provisioning below fails before anything is
  // written into it.
  await withTempExportDir(tmpdir(), async (exportDir) => {
    process.env['RECONCIL_EXPORT_DIR'] = exportDir;

    const client = new Anthropic();
    const { db, dispose } = await provisionDb();
    try {
      const produce = makeAgentProducer({ client, model: args.model });
      const seedCase = makeSeedCase(db);

      console.error(`running ${String(dataset.length)} cases × ${String(args.runs)} run(s) on ${args.model}…`);
      const cases = await runSuite(dataset, args.runs, {
        seedCase,
        produce,
        makeResolver: dbResolver,
        onCase: (r) => {
          const safety = (['citation', 'guardrail', 'injection'] as const).every((m) => !r.metrics[m].applicable || r.metrics[m].passed);
          console.error(`  ${r.id}: ${safety ? 'ok' : 'SAFETY FAIL'}`);
        },
      });

      const gate = evaluateGate(cases);
      const report = buildReport(
        { suite: args.suite, model: args.model, runs: args.runs, generatedAt: new Date().toISOString() },
        cases,
        gate,
      );

      const outDir = resolve(args.out);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'scorecard.json'), toJson(report), 'utf8');
      writeFileSync(join(outDir, 'scorecard.md'), toMarkdown(report), 'utf8');

      console.error(toMarkdown(report));

      if (!gate.passed) {
        // Surface the grader's detail for every applicable metric that failed, so the CI
        // log explains WHY (e.g. "expected X not found" = rounding, "fabricated Y", wrong
        // figure) without needing the JSON artifact.
        console.error('Failing details:');
        for (const c of cases) {
          for (const m of METRICS) {
            const outcome = c.metrics[m];
            if (!outcome.applicable || outcome.passed) continue;
            const failing = c.runs.find((r) => !r[m].pass);
            console.error(`  ${c.id} · ${m}: ${failing?.[m].detail ?? '(failed)'}`);
          }
        }
      }

      console.error(`\nreports → ${outDir}`);
      if (!gate.passed) process.exitCode = 1;
    } finally {
      await dispose();
    }
  });
}

// Runs only when invoked directly (tsx src/run.ts …); inert when imported (main.ts's `evals`
// command delegates to runEvals() directly) — mirrors keygen.ts/seed.ts/http.ts.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEvals().catch((err: unknown) => {
    console.error('eval run failed:', err);
    process.exit(1);
  });
}
