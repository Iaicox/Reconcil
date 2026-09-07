/**
 * Single source of truth for the CLI's default model. Previously duplicated 4× across
 * `evals/args.ts`, `repl.ts`, and `main.ts`'s usage banner (twice) — an undated alias that
 * would silently drift out of sync if any one copy moved without the others.
 *
 * `claude-opus-4-8` names Opus 4.8 specifically — it is NOT a floating "current production
 * Opus" alias. `client.models.list()` on 2026-09-08 returns claude-opus-5, claude-opus-4-8,
 * claude-opus-4-7, claude-opus-4-6 and claude-opus-4-5-20251101 as separate ids, so a newer
 * Opus arrives under a new name and this id does not follow it. An earlier version of this
 * comment claimed otherwise, and that claim was used to explain away a failing eval gate.
 *
 * What is still true: only 4.5 has a DATED form, so there is no snapshot id to pin 4.8 below
 * the version level, and the API echoes the requested id back in `response.model` — a
 * re-point of the snapshot behind this name would therefore be invisible from the response.
 * The scorecard records what came back (see evals/scorecard.ts) because it is the only
 * handle available, not because it can prove the baseline held.
 */
export const DEFAULT_MODEL = 'claude-opus-4-8';
