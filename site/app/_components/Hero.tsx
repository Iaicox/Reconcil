import { Fragment } from 'react';

import { CONTACT_MAILTO } from '../_lib/site';
import { ButtonLink, Container, DoubleRule, RuledLink } from './ui';

// Every figure below is verbatim from the repository's demo fixture (docs/design/
// real-materials.md): the INV-OPEN suggestion as recon_suggest_matches returns it.
// 0.37857142857142856 is the real confidence — rounded for display only, never tidied.
const match = {
  id: 'a35416c3-9c2a-45a1-9ca1-04298ad68bad',
  record: [
    ['direction', 'receivable'],
    ['amount', '300.00 EUR'],
    ['open_amount', '300'],
    ['expected_address', 'not set'],
  ],
  settlement: [
    ['chain_id', '1'],
    ['tx_hash', '0xa4a4…'],
    ['log_index', '0'],
    ['block_time', '2026-06-13T10:00:00.000Z'],
    ['from', '0x2222…'],
    ['token', 'verified · peg EUR · 6 dec'],
  ],
  rules: [
    ['amount', '0.35', 'valued 300 vs open 300 EUR'],
    ['date', '0.0285', 'within 12d of the reference date'],
  ],
};

const cellLabel =
  'font-mono text-[10px] font-medium uppercase leading-none tracking-[0.14em] text-ink-3';

function StateBanner() {
  return (
    <div className="border-b border-rule bg-state-bg px-4 py-2">
      <span className="font-mono text-[11.5px] leading-none font-semibold tracking-[0.13em] text-state">
        AWAITING YOUR CONFIRMATION
      </span>
    </div>
  );
}

// Desktop card: record | applied figure | settlement, then the rule table that sums to the
// confidence. Maps 1:1 to the "1b hero — light/dark" comps.
function MatchCardDesktop() {
  return (
    <div className="mt-3.5 border border-rule bg-surface">
      <div className="flex items-center justify-between border-b border-rule px-4 py-[11px]">
        <span className="font-mono text-xs leading-none font-medium">suggestion 1 of 2</span>
        <span className="font-mono text-[11px] leading-none text-ink-3">match_id {match.id}</span>
      </div>
      <StateBanner />

      <div className="grid grid-cols-[1fr_300px_1fr]">
        <div className="p-[22px] pb-6">
          <span className={cellLabel}>Record</span>
          <p className="mt-3 mb-4 font-mono text-[22px] leading-none font-medium tracking-[-0.01em]">
            INV-OPEN
          </p>
          <div className="grid grid-cols-[136px_1fr] gap-x-3 gap-y-[7px] font-mono text-xs leading-normal">
            {match.record.map(([k, v]) => (
              <Fragment key={k}>
                <span className="text-ink-3">{k}</span>
                <span className={k === 'expected_address' ? 'text-state' : 'tabular-nums'}>
                  {v}
                </span>
              </Fragment>
            ))}
          </div>
        </div>

        <div className="border-x border-rule bg-hl p-[22px] pb-6">
          <span className={cellLabel}>amount_applied</span>
          <p className="mt-2.5 font-mono text-[58px] leading-none font-medium tracking-[-0.045em] tabular-nums">
            300.00
            <span className="ml-2 text-lg tracking-normal text-ink-2">EUR</span>
          </p>
          <DoubleRule className="mt-4" />
          <p className="mt-3.5 font-mono text-xs leading-relaxed text-ink-2">
            fiat_value 300 — same-currency stablecoin, settled at face value. No price snapshot
            involved.
          </p>
        </div>

        <div className="p-[22px] pb-6">
          <span className={cellLabel}>Settlement</span>
          <p className="mt-3 mb-4 font-mono text-[22px] leading-none font-medium tracking-[-0.01em] tabular-nums">
            300 EURC
          </p>
          <div className="grid grid-cols-[100px_1fr] gap-y-[7px] font-mono text-xs leading-normal">
            {match.settlement.map(([k, v]) => (
              <Fragment key={k}>
                <span className="text-ink-3">{k}</span>
                <span>{v}</span>
              </Fragment>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_300px_1fr] border-t border-rule">
        <div className="col-span-2 px-[22px] pt-[18px] pb-5">
          <span className={cellLabel}>Confidence is the sum of the rules that fired</span>
          <div className="mt-3.5 grid grid-cols-[84px_74px_1fr] gap-y-2 font-mono text-xs leading-normal">
            {match.rules.map(([rule, weight, why]) => (
              <Fragment key={rule}>
                <span>{rule}</span>
                <span className="pr-6 text-right tabular-nums">{weight}</span>
                <span className="text-ink-2">{why}</span>
              </Fragment>
            ))}
          </div>
          <DoubleRule className="my-3 w-[182px]" />
          <div className="grid grid-cols-[84px_74px_1fr] font-mono text-xs leading-normal font-medium">
            <span>Σ</span>
            <span className="pr-6 text-right tabular-nums">0.3785</span>
            <span className="text-ink-3">0.37857142857142856 — rounded for display only</span>
          </div>
        </div>
        <div className="border-l border-rule px-[22px] pt-[18px] pb-5">
          <span className={cellLabel}>confidence</span>
          <p className="mt-2.5 font-mono text-[34px] leading-none font-medium tracking-[-0.03em] tabular-nums">
            0.379
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-rule bg-strip px-4 py-[11px]">
        <span className="font-mono text-[11.5px] text-ink-2">
          → recon_confirm_match&nbsp;&nbsp;→ recon_reject_match
        </span>
        <span className="font-mono text-[10.5px] text-ink-3">
          one of these runs only when you say so
        </span>
      </div>
    </div>
  );
}

// Mobile card: the applied figure leads, details compress to key rows — per the
// "1b hero — mobile" comp.
function MatchCardMobile() {
  return (
    <div className="border border-rule bg-surface">
      <StateBanner />
      <div className="border-b border-rule px-3 pt-4 pb-3.5">
        <span className="font-mono text-[9.5px] font-medium uppercase leading-none tracking-[0.14em] text-ink-3">
          amount_applied
        </span>
        <p className="mt-2 font-mono text-[44px] leading-none font-medium tracking-[-0.045em] tabular-nums">
          300.00
          <span className="ml-[7px] text-[15px] tracking-normal text-ink-2">EUR</span>
        </p>
      </div>
      <div className="grid grid-cols-[92px_1fr] gap-y-[7px] border-b border-rule px-3 py-3.5 font-mono text-[11.5px] leading-snug">
        <span className="text-ink-3">record</span>
        <span>INV-OPEN · 300.00 EUR</span>
        <span className="text-ink-3">settlement</span>
        <span>300 EURC · chain 1</span>
        <span className="text-ink-3">tx_hash</span>
        <span>0xa4a4… · log 0</span>
        <span className="text-ink-3">block_time</span>
        <span>2026-06-13</span>
      </div>
      <div className="px-3 py-3.5">
        <div className="grid grid-cols-[66px_62px] gap-y-[7px] font-mono text-[11.5px] leading-snug">
          {match.rules.map(([rule, weight]) => (
            <Fragment key={rule}>
              <span>{rule}</span>
              <span className="text-right tabular-nums">{weight}</span>
            </Fragment>
          ))}
        </div>
        <DoubleRule className="my-2.5 w-32" />
        <div className="grid grid-cols-[66px_62px] font-mono text-[11.5px] leading-snug font-medium">
          <span>confidence</span>
          <span className="text-right tabular-nums">0.379</span>
        </div>
      </div>
    </div>
  );
}

const proof = [
  { label: 'docker compose up', className: 'pt-3 pr-3 lg:pt-4 lg:pr-4' },
  {
    label: 'Ethereum + Base',
    className: 'hidden lg:block lg:border-l lg:border-rule lg:pt-4 lg:px-4',
  },
  { label: 'read-only, no keys', className: 'border-l border-rule pt-3 px-3 lg:pt-4 lg:px-4' },
  { label: '19 MCP tools', className: 'pt-3 pr-3 lg:border-l lg:border-rule lg:pt-4 lg:px-4' },
  { label: 'Apache-2.0', className: 'border-l border-rule pt-3 pl-3 lg:pt-4 lg:pl-4 lg:pr-0' },
];

export function Hero() {
  return (
    <section id="top">
      <Container className="pt-8 lg:pt-[60px]">
        <div className="grid items-end gap-9 lg:grid-cols-[1fr_420px] lg:gap-16">
          <div>
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.15em] text-ink-3 lg:text-[11px] lg:leading-none lg:tracking-[0.17em]">
              Stablecoin payment ↔ invoice reconciliation
            </span>
            <h1 className="mt-4 text-[33px] leading-[1.05] font-semibold tracking-[-0.03em] text-balance lg:mt-[22px] lg:max-w-[22ch] lg:text-[62px] lg:leading-[1.01] lg:tracking-[-0.038em]">
              Know which invoices are actually paid.
            </h1>
            <DoubleRule className="mt-5 mb-3.5 lg:mt-7 lg:mb-[18px] lg:max-w-[560px]" />
            <p className="font-mono text-[13.5px] leading-normal font-medium lg:text-base lg:tracking-[-0.01em]">
              Every figure traces back to a transaction hash.
            </p>
          </div>

          <div>
            <p className="text-[15px] leading-[1.65] text-ink-2 text-pretty lg:text-[15.5px]">
              Reconcil reads your wallets, matches on-chain settlements to your invoices, and hands
              your accountant journal drafts to review.
              <span className="hidden lg:inline">
                {' '}
                It runs on your own machine and never holds a key.
              </span>
            </p>
            <div className="mt-6 flex flex-col gap-1.5 lg:mt-[26px] lg:flex-row lg:items-center lg:gap-5">
              <ButtonLink
                href={CONTACT_MAILTO}
                className="h-[50px] w-full text-sm lg:h-[46px] lg:w-auto lg:px-[22px]"
              >
                Book 20 minutes
              </ButtonLink>
              <RuledLink
                href={CONTACT_MAILTO}
                className="self-center text-[13px] lg:self-auto lg:text-[13.5px]"
              >
                or email instead
              </RuledLink>
            </div>
            <p className="mt-4 hidden font-mono text-xs leading-[1.65] text-ink-3 lg:mt-[22px] lg:block">
              Early, and validating with a handful of teams. Read-only by design — no keys, no
              custody.
            </p>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-[7px] lg:mt-12">
          <p className="hidden font-mono text-[13px] leading-normal text-ink-2 lg:block">
            <span className="text-ink-3">you ›</span> Match my outstanding invoices to the on-chain
            stablecoin settlements you can find, and show me the suggested matches.
          </p>
          <p className="font-mono text-[11.5px] leading-normal text-ink-3 lg:text-xs">
            → recon_suggest_matches
          </p>
        </div>

        <div className="hidden lg:block">
          <MatchCardDesktop />
        </div>
        <div className="mt-2.5 lg:hidden">
          <MatchCardMobile />
          <p className="mt-3 font-mono text-[10.5px] leading-[1.55] text-ink-3">
            Illustration. Confidence is the sum of the rules that fired.
          </p>
        </div>

        <div className="mt-[18px] hidden grid-cols-2 gap-10 lg:grid">
          <div className="flex gap-4">
            <span aria-hidden="true" className="w-px flex-none bg-dr" />
            <p className="text-[13.5px] leading-relaxed text-ink-2 text-pretty">
              It scores 0.379 rather than about 0.73 because this invoice carries no{' '}
              <span className="font-mono">expected_address</span>, so the 0.35 address rule never
              fires. A weighted rule table, not a model&rsquo;s opinion — and it adds up by hand.
            </p>
          </div>
          <div className="flex gap-4">
            <span aria-hidden="true" className="w-px flex-none bg-dr" />
            <p className="text-[13.5px] leading-relaxed text-ink-2 text-pretty">
              Illustration. The frame and the question are verbatim from the 30-case eval suite
              that gates each release; the answer is the tool&rsquo;s output, not the model&rsquo;s
              prose. The model asks and shows — it never does the arithmetic.
            </p>
          </div>
        </div>

        <div className="mt-6 pb-7 lg:mt-11 lg:pb-10">
          <div className="grid grid-cols-2 border-t border-rule lg:grid-cols-5">
            {proof.map((p) => (
              <span
                key={p.label}
                className={`font-mono text-[11px] leading-[1.6] text-ink-2 lg:text-xs lg:leading-normal ${p.className}`}
              >
                {p.label}
              </span>
            ))}
          </div>
          <p className="mt-4 font-mono text-[10.5px] leading-[1.55] text-ink-3 lg:hidden">
            Early, and validating with a handful of teams. Figures from the repository&rsquo;s demo
            fixture.
          </p>
          <p className="mt-[18px] hidden font-mono text-[11px] leading-normal text-ink-3 lg:block">
            Figures from the repository&rsquo;s demo fixture — reproducible by anyone who runs the
            stack.
          </p>
        </div>
      </Container>
    </section>
  );
}
