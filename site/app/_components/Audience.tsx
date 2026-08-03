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
    <section className="border-t border-rule bg-surface py-20 sm:py-24">
      <Container>
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            Who it&rsquo;s for
          </h2>
        </div>
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:gap-6">
          {audiences.map((a) => (
            <div key={a.title} className="border border-rule bg-paper p-8">
              <h3 className="text-xl font-semibold">{a.title}</h3>
              <p className="mt-3 leading-relaxed text-ink-2">{a.body}</p>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
