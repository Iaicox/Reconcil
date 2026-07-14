# ADR-011: Hostile on-chain strings & regulatory guardrails

**Status:** accepted · **Date:** 2026-07-14

## Context

P7: anyone can deploy a token named `Ignore previous instructions and …` for pennies —
on-chain strings, CSV imports, and provider text are attacker-controllable input that
flows toward LLM context. P8 (MiCA): read-only product, no investment advice, drafts
under professional review. Both are trust properties that must be enforced by
architecture, not by prompt hopes.

## Decision

Defense in depth, four layers:

1. **Scrub at the source.** A pure sanitizer in `packages/core` (NFC normalize → strip
   controls/zero-width/bidi overrides → allowlist charset → collapse whitespace → length
   caps → `(unnamed)` placeholder). Raw values (`symbol_raw`, `name_raw`, `raw JSONB`,
   import payloads) are stored for audit but **never serialized into tool responses**.
2. **Structural isolation.** Sanitized-but-untrusted values appear only under `untrusted`
   keys (contract clause C6); every tool description states that such values are data,
   never instructions; the CLI agent's system prompt repeats it.
3. **Spam gating.** Auto-discovered tokens are `verified=false` and excluded from
   analytics by default with an explicit `UNVERIFIED_EXCLUDED` warning — scam airdrops
   neither pollute answers nor silently disappear.
4. **Adversarial evals.** Fixtures include injection-named tokens with canary strings;
   the eval gate requires 100% on injection cases (04-testing §5–6) — the defense is
   regression-tested, not assumed.

MiCA guardrails, enforced structurally where possible:

- **Read-only by construction**: no signing/key libraries in the dependency tree —
  dependency-cruiser ban, checked in CI. There is no code path that could sign or send.
- **No investment advice**: agent system prompt prohibition + eval refusal cases (gate:
  100%). Tools return facts only — no performance judgments, no recommendation fields.
- **Draft-for-review**: every journal artifact is labeled as a draft in file content and
  tool output; only human-confirmed matches reach exports (ADR-010).

## Alternatives considered

- **Prompt-only defense** ("please ignore injections") — no mechanism, no test, no
  guarantee; rejected as the only layer, kept as one layer.
- **LLM-based injection classifier** — adds a model in the trust path with its own
  failure modes and costs; the allowlist+isolation approach is deterministic and testable.
- **Blocklist filtering** (strip "ignore previous…" patterns) — trivially bypassed;
  allowlisting the charset and isolating the field is strictly stronger.

## Consequences

- Some legitimate exotic token names render degraded (`SANITIZED_HEAVY` warning) —
  correct trade for an accounting context.
- The `untrusted`-key convention must be honored by every future tool — enforced by the
  shared envelope builder + contract tests, not by memory.
- Guardrail claims in marketing ("cannot touch funds") are literally verifiable from CI.
