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
import { buildReport, toJson, toMarkdown, type ReportMeta } from './evals/scorecard.js';
import { makeSeedCase } from './evals/seed-case.js';
import { SMOKE_IDS, selectSmokeDataset } from './evals/smoke.js';
import type { CaseResult } from './evals/types.js';

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
 * Grade, gate and write the scorecard for whatever cases are in hand, returning the output
 * directory. Shared by the normal path and the aborted one, so a partial run is reported
 * through exactly the same renderer — an `aborted` meta is the only difference, and it is
 * what stops a partial suite from printing a gate verdict it has not earned.
 */
function writeReport(
  args: { suite: string; model: string; runs: number; out: string },
  cases: CaseResult[],
  resolvedModels: ReadonlySet<string>,
  aborted?: NonNullable<ReportMeta['aborted']>,
): string {
  const report = buildReport(
    {
      suite: args.suite,
      model: args.model,
      // exactOptionalPropertyTypes: omit the key entirely rather than set undefined.
      ...(resolvedModels.size > 0 ? { resolvedModel: [...resolvedModels].sort().join(', ') } : {}),
      runs: args.runs,
      generatedAt: new Date().toISOString(),
      ...(aborted ? { aborted } : {}),
    },
    cases,
    evaluateGate(cases),
  );

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'scorecard.json'), toJson(report), 'utf8');
  writeFileSync(join(outDir, 'scorecard.md'), toMarkdown(report), 'utf8');
  console.error(toMarkdown(report));
  return outDir;
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
  // --cases narrows to specific ids, for investigating a handful of failures without
  // paying for the whole suite. It filters the dataset only; the prompt, the tools and
  // every schema the model sees are identical either way.
  const selected = args.cases.length > 0 ? all.filter((c) => args.cases.includes(c.id)) : all;
  if (args.cases.length > 0 && selected.length !== args.cases.length) {
    const missing = args.cases.filter((id) => !all.some((c) => c.id === id));
    throw new Error(`unknown case id(s): ${missing.join(', ')}`);
  }
  const dataset = args.smoke ? selectSmokeDataset(all, SMOKE_IDS) : selected;

  // Route recon-backed exports (a Face B journal-draft case's export_journal_drafts) to a
  // throwaway dir instead of cwd/exports (baseDir default). withTempExportDir owns creation
  // AND cleanup, including the case where DB provisioning below fails before anything is
  // written into it.
  await withTempExportDir(tmpdir(), async (exportDir) => {
    process.env['RECONCIL_EXPORT_DIR'] = exportDir;

    const client = new Anthropic();
    const { db, dispose } = await provisionDb();
    try {
      // `args.model` may be an undated alias that silently re-points; record what actually
      // answered so a red gate can be attributed to the code rather than a moved baseline.
      const resolvedModels = new Set<string>();
      const usage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      const produce = makeAgentProducer({
        client,
        model: args.model,
        onResolvedModel: (m) => resolvedModels.add(m),
        onUsage: (u) => {
          usage.input += u.input;
          usage.output += u.output;
          usage.cacheCreation += u.cacheCreation;
          usage.cacheRead += u.cacheRead;
        },
      });
      const seedCase = makeSeedCase(db);

      console.error(`running ${String(dataset.length)} cases × ${String(args.runs)} run(s) on ${args.model}…`);
      // Accumulated as each case completes, so a suite that dies partway still has
      // something to write. A session can fail on something that is not about the cases at
      // all — an API usage limit, a dropped connection — and every case up to that point is
      // paid for and cannot be re-run for free.
      const completed: CaseResult[] = [];
      let cases: CaseResult[];
      try {
        cases = await runSuite(dataset, args.runs, {
          seedCase,
          produce,
          makeResolver: dbResolver,
          onCase: (r) => {
            completed.push(r);
            const safety = (['citation', 'guardrail', 'injection'] as const).every((m) => !r.metrics[m].applicable || r.metrics[m].passed);
            console.error(`  ${r.id}: ${safety ? 'ok' : 'SAFETY FAIL'}`);
          },
        });
      } catch (err) {
        if (completed.length > 0) {
          const outDir = writeReport(args, completed, resolvedModels, {
            completedCases: completed.length,
            totalCases: dataset.length,
            reason: err instanceof Error ? err.message : String(err),
          });
          console.error(
            `\nsuite stopped after ${String(completed.length)}/${String(dataset.length)} cases — ` +
              `partial scorecard written to ${outDir}`,
          );
        }
        throw err;
      }

      if (resolvedModels.size > 0) {
        console.error(`model resolved to: ${[...resolvedModels].sort().join(', ')}`);
      }
      // Cached input bills at a fraction of new input, so the read/creation split is the
      // whole point of the cache breakpoint in agent.ts — print it rather than assume it.
      const cachedShare = usage.cacheRead + usage.input === 0
        ? 0
        : Math.round((usage.cacheRead / (usage.cacheRead + usage.input)) * 100);
      console.error(
        `tokens — input ${String(usage.input)}, cache read ${String(usage.cacheRead)} ` +
          `(${String(cachedShare)}% of input served from cache), cache writes ` +
          `${String(usage.cacheCreation)}, output ${String(usage.output)}`,
      );

      // The Markdown ends in the transcript appendix — every failing case's grader reason,
      // trajectory and answer — so the CI log explains WHY on its own. That replaces the
      // "Failing details" summary this used to print separately, and it prints for a
      // failing case even when the suite still clears the 90% gate.
      const outDir = writeReport(args, cases, resolvedModels);
      console.error(`\nreports → ${outDir}`);
      if (!evaluateGate(cases).passed) process.exitCode = 1;
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
