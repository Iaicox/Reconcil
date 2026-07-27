import { Container } from './ui';

// Short, honest framing of the pain the product removes. No metrics we can't cite (P1/P2 ethos
// carried into the copy) — just the shape of the problem.
export function Problem() {
  return (
    <section className="border-y border-zinc-200 bg-zinc-50 py-20 sm:py-24 dark:border-zinc-800 dark:bg-zinc-900/40">
      <Container>
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Stablecoin invoicing breaks your books
          </h2>
          <p className="mt-6 text-lg text-zinc-600 text-pretty dark:text-zinc-400">
            Payments land on-chain in USDC or EURC, but your ledger is in EUR or USD. Tying each
            transfer to the right invoice — with partials, overpayments and gas fees in the mix, at
            the exchange rate on the day it settled — is manual, error-prone, and painful to audit
            when a client or a tax authority asks how you got the number.
          </p>
          <p className="mt-4 text-lg font-medium text-zinc-800 dark:text-zinc-200">
            Reconcil makes that reconciliation deterministic, traceable, and something you run
            yourself.
          </p>
        </div>
      </Container>
    </section>
  );
}
