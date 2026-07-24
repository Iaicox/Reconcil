/**
 * `evals run` entry (04-testing.md §5/§6): seed a fixture DB, run the Agent Tool Runner
 * over the dataset, grade deterministically, apply the demo-readiness gate, and write a
 * JSON + Markdown scorecard. Exits non-zero when the gate fails so CI blocks the demo.
 *
 * DB: `DATABASE_URL` if set, else a throwaway testcontainers Postgres (needs Docker).
 * The Anthropic API key is read from `ANTHROPIC_API_KEY` (the only place it is needed).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { coreDatasetPath, loadDataset, type EvalCase } from '@pet-crypto/evals';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

import { makeAgentProducer } from './evals/agent.js';
import { evaluateGate } from './evals/gate.js';
import { runSuite } from './evals/harness.js';
import { dbResolver } from './evals/resolver.js';
import { buildReport, toJson, toMarkdown } from './evals/scorecard.js';
import { makeSeedCase } from './evals/seed-case.js';

const DEFAULT_MODEL = 'claude-opus-4-8';
// A 5-case subset spanning the metric mix for the PR smoke job (§7): balance freshness,
// native flow, total gas, a guardrail, an injection.
const SMOKE_IDS = new Set(['cover-001', 'flow-001', 'gas-001', 'guard-001', 'inj-001']);

interface Args {
  suite: string;
  runs: number;
  smoke: boolean;
  model: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { suite: 'core', runs: 3, smoke: false, model: DEFAULT_MODEL, out: 'eval-reports' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') args.smoke = true;
    else if (a === '--suite') args.suite = argv[++i] ?? args.suite;
    else if (a === '--runs') args.runs = Number(argv[++i] ?? args.runs);
    else if (a === '--model') args.model = argv[++i] ?? args.model;
    else if (a === '--out') args.out = argv[++i] ?? args.out;
    else if (a === 'run') continue; // tolerate `evals run …`
  }
  if (args.smoke) args.runs = 1;
  return args;
}

/** DATABASE_URL if provided, else a throwaway container. Returns db + a disposer. */
async function provisionDb(): Promise<{ db: Db; dispose: () => Promise<void> }> {
  const url = process.env['DATABASE_URL'];
  if (url !== undefined && url !== '') {
    const pool = new Pool({ connectionString: url });
    await runMigrations(pool);
    return { db: createDb(pool), dispose: () => pool.end() };
  }
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  return {
    db: createDb(pool),
    dispose: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('ANTHROPIC_API_KEY is required to run the eval agent (the only place it is needed).');
    process.exitCode = 1;
    return;
  }

  const all = loadDataset(coreDatasetPath());
  const dataset: EvalCase[] = args.smoke ? all.filter((c) => SMOKE_IDS.has(c.id)) : all;

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
    console.error(`\nreports → ${outDir}`);
    if (!gate.passed) process.exitCode = 1;
  } finally {
    await dispose();
  }
}

main().catch((err: unknown) => {
  console.error('eval run failed:', err);
  process.exit(1);
});
