import { Container } from './ui';

const steps = [
  {
    n: '01',
    title: 'Import invoices',
    body: 'Bring invoices in as CSV — one command. Receivables and payables, any currency, deduplicated on re-import.',
  },
  {
    n: '02',
    title: 'Match payments',
    body: 'A deterministic engine matches on-chain settlements to invoices across many-to-many splits: partial payments, overpayments and network fees included.',
  },
  {
    n: '03',
    title: 'Confirm',
    body: 'You approve each match — human-in-the-loop. Record status tracks open, partial, paid and overpaid as you go.',
  },
  {
    n: '04',
    title: 'Export',
    body: 'EUR/USD fixed at payment date with VAT tagged, exported as QuickBooks or Xero manual-journal drafts for review.',
  },
];

export function HowItWorks() {
  return (
    <section className="py-20 sm:py-24">
      <Container>
        <div className="max-w-2xl">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">How it works</h2>
          <p className="mt-4 text-lg text-zinc-600 dark:text-zinc-400">
            From a wallet address and a stack of invoices to review-ready journal entries — in four
            steps, all deterministic.
          </p>
        </div>

        <ol className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((step) => (
            <li
              key={step.n}
              className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-800 dark:bg-zinc-900/50"
            >
              <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                {step.n}
              </span>
              <h3 className="mt-2 text-lg font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{step.body}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
