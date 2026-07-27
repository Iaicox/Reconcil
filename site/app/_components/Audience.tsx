import { Container } from './ui';

const audiences = [
  {
    title: 'Teams paid in stablecoins',
    body: 'EU SMBs, freelancers and agencies invoicing clients in USDC or EURC — who need their on-chain income to reconcile cleanly against the books.',
  },
  {
    title: 'The accountants who close them',
    body: 'Solo accountants and firms serving crypto-paid clients, who need EUR/USD values fixed at payment date, VAT tagged, and every figure defensible.',
  },
];

export function Audience() {
  return (
    <section className="border-t border-zinc-200 bg-zinc-50 py-20 sm:py-24 dark:border-zinc-800 dark:bg-zinc-900/40">
      <Container>
        <div className="max-w-2xl">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Who it&rsquo;s for</h2>
        </div>
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          {audiences.map((a) => (
            <div
              key={a.title}
              className="rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <h3 className="text-xl font-semibold">{a.title}</h3>
              <p className="mt-3 text-zinc-600 dark:text-zinc-400">{a.body}</p>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
