/**
 * Single source of truth for the CLI's default model. Previously duplicated 4× across
 * `evals/args.ts`, `repl.ts`, and `main.ts`'s usage banner (twice) — an undated alias that
 * would silently drift out of sync if any one copy moved without the others.
 *
 * `claude-opus-4-8` is an UNDATED alias: it always resolves to Anthropic's current
 * production Opus, so the nightly `evals-full` baseline silently moves whenever the alias
 * re-points. That trade-off is fine for the demo REPL (want the latest model) and for now
 * in the eval runner too; pin a dated snapshot id here instead once a stable, comparable
 * scorecard across runs matters more than always running the newest model.
 */
export const DEFAULT_MODEL = 'claude-opus-4-8';
