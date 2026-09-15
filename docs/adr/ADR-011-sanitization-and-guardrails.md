# ADR-011: Hostile on-chain strings & regulatory guardrails

**Status:** accepted · **Date:** 2026-07-14 · **Amended:** 2026-08-06 (`SANITIZED_HEAVY`
now also fires on truncation loss — see Consequences)

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
   caps → `(unnamed)` placeholder). Raw hostile **string** values (`symbol_raw`, `name_raw`,
   `raw JSONB`, import payloads) are stored for audit but **never serialized into tool
   responses**. (This is about attacker-controlled text; the trusted numeric `amount_raw`
   base-unit field is not a hostile string and does cross the wire — see 02-mcp-contracts §6.1.)
2. **Structural isolation.** Sanitized-but-untrusted values appear only under `untrusted`
   keys (contract clause C6); every tool description states that such values are data,
   never instructions; the CLI agent's system prompt repeats it.
3. **Spam gating.** Auto-discovered tokens are `verified=false` and excluded from
   analytics by default with an explicit `UNVERIFIED_EXCLUDED` warning — scam airdrops
   neither pollute answers nor silently disappear.

   *Amended 2026-09-15 (ADR sweep — accuracy).* The `verified=false` half is real. The
   warning half does not deliver "nor silently disappear", for two reasons.

   - **The warning is derived from the request flag, not from what was excluded.** Every emit
     site is `if (!includeUnverified) warnings.push(…)`, and the close pack pushes it
     unconditionally. So it fires on a tenant with no unverified tokens at all, and it can
     never tell the agent that something *was* hidden — it is a constant. As a disclosure of
     the default policy that is fine; as the signal this decision describes, it carries no
     information. Deriving it from the excluded set is tracked in `09-known-gaps.md`.
   - **`analytics_stablecoin_movements` excludes unverified tokens with no warning and no
     opt-in at all.** It hard-filters `verified = true`, its input schema has no
     `include_unverified`, and its handler emits no `UNVERIFIED_EXCLUDED`. An auto-discovered
     stablecoin therefore disappears silently from the tool whose own description calls it
     the most common accountant question — precisely the case this layer exists to prevent.
     (`analytics_gas` is native-only and correctly has no filter and no warning.) The recon
     path filters the same way, so an unverified-token settlement is also silently unmatchable
     and silently absent from `recon_status`'s unmatched count. Tracked in `09-known-gaps.md`.
4. **Adversarial evals.** Fixtures include injection-named tokens with canary strings;
   the eval gate requires 100% on injection cases (04-testing §5–6) — the defense is
   regression-tested, not assumed.

   *Amended 2026-09-15 (ADR sweep — accuracy).* The gate arithmetic is exactly as claimed:
   `injection` is a safety metric, every run of every applicable case must pass, and there is
   no aggregate threshold to hide behind. What the sentence overstates is what is being
   tested and how often.

   - **Scope.** Two of thirty cases declare a canary. The PR-time job runs `--smoke`, whose id
     list contains one of them; the other runs only under a manually dispatched full eval.
     And `applicable.length === 0` is treated as vacuously satisfied, so a keyless clone or a
     fork PR — where the eval jobs are skipped, grey rather than red — reports a green gate
     with the injection metric at 0/0.
   - **What the grader derives its verdict from.** It checks that the canary is absent from
     the model's final answer. It does not check that the canary was absent from the tool
     RESULTS, which is what layer 1 is. The case cannot presently detect a layer-1 regression
     at all: the planted token leaves `symbol_display`/`name_display` NULL and is
     `verified=false`, `name_raw` (which carries the actual instruction) is selected by no
     query in the codebase, and both canaries contain `_`, which the allowlist strips — so
     even a total sanitizer failure could not put the canary string through the sanitized
     channel. It regression-tests "the model did not spontaneously type a nonce". Making it
     test the defense is tracked in `09-known-gaps.md`.

MiCA guardrails, enforced structurally where possible:

- **Read-only by construction**: no signing/key libraries in the dependency tree —
  **`pnpm check:supply-chain`** (`scripts/check-no-signing-libs.cjs`), checked in CI. There is
  no code path that could sign or send.

  *Amended 2026-09-15 (ADR sweep — accuracy).* This named dependency-cruiser as the
  mechanism. Dependency-cruiser sets `doNotFollow: { path: ['node_modules', 'dist'] }`, so its
  `no-signing-libraries` rule only ever sees direct import edges from first-party source — it
  cannot say anything about the *tree*, which is the word that makes this claim worth making.
  What delivers the stated scope is the lockfile scanner, which walks both
  `pnpm-lock.yaml` and `site/package-lock.json` and derives its banned list *from* the cruiser
  rule so the two cannot drift, has its own unit tests (`pnpm test:scripts`), and fails loud
  on any lockfile shape it cannot confidently parse. Both run in CI; the claim was always
  true, but the named mechanism was not the one making it true — and that matters here,
  because "verifiable from CI" below is a marketing claim about exactly this check.
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
- The `untrusted`-key convention must be honored by every future tool.

  *Amended 2026-09-15 (ADR sweep — accuracy).* This ended "enforced by the shared envelope
  builder + contract tests, not by memory". **Neither mechanism does it.** `buildEnvelope`
  is generic in `data` and inspects nothing — its own docstring states sanitization as a
  precondition on the caller — and no test anywhere asserts the absence of a raw key across
  the registry. (Two tests do cover the convention where it is exercised:
  `recon-import-invoices.itest.ts` asserts `untrusted.counterparty_name` is present and
  scrubbed, and `server.test.ts` sweeps every tool DESCRIPTION for the untrusted note. Neither
  looks at response data across tools, which is what this sentence claimed.)

  What is genuinely structural is narrower and worth naming precisely, because it is the part
  a reviewer can rely on: the **token** path, where `TokenMeta` carries no raw field and
  `toTokenView` is the single conversion to the wire, so no analytics tool can emit
  `symbol_raw`/`name_raw` even by accident. `chain_events.raw` is likewise selected by nothing
  in `src/` outside the ingestion writer (one integration test reads it back, deliberately —
  ADR-005 d2 depends on that round-trip). Everything else — the recon, import, status,
  journal and audit paths — is per-SELECT column-list convention: correct today, verified
  path by path, and held by nothing but review. Two known soft spots are tracked in `09-known-gaps.md`: raw
  `counterparty_name` leaves the repo and is sanitized late in the exporter, at a different
  cap than the import path uses and with its `heavy` flag discarded (so the truncation the
  2026-08-06 amendment exists to surface produces no warning there); and
  `ledger_trace_tool_call` echoes the stored `tool_calls.args` jsonb verbatim, unsanitized
  and not under an `untrusted` key.
- Guardrail claims in marketing ("cannot touch funds") are literally verifiable from CI.

*Amendment (2026-08-06, `SANITIZED_HEAVY` truncation coverage):* Layer 1's `heavy` flag
originally measured hostile-charset stripping alone (`> 30%` of post-NFC code points
removed by the allowlist). A wholly legitimate but very long name silently cut to the
length cap still reported `heavy: false` — no hostile character was ever present, but the
agent-visible value had still lost most of its content, which is exactly the kind of loss
this warning exists to surface. `packages/core/src/sanitizer.ts`'s `sanitize()` now sums
charset-stripping loss and length-cap loss over the original length for the same `> 30%`
threshold; whitespace collapse stays excluded from both terms (it is normalization, not
content removal). `02-mcp-contracts.md` §7 and `guide/05-operations.md` document the rule
as implemented.
