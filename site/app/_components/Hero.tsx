import { CONTACT_MAILTO, GITHUB_URL } from '../_lib/site';
import { ArrowIcon, ButtonLink, Container, GitHubIcon } from './ui';

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      {/* Soft accent wash behind the hero — pure CSS, no image asset (keeps static export clean). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[38rem] bg-gradient-to-b from-emerald-50 to-transparent dark:from-emerald-950/30"
      />
      <Container className="pt-20 pb-16 sm:pt-28 sm:pb-24">
        <div className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
            Open-source · Self-hosted · MCP-native
          </span>

          <h1 className="mt-6 text-4xl font-bold tracking-tight text-balance sm:text-5xl md:text-6xl">
            Reconcile stablecoin payments to invoices —{' '}
            <span className="bg-gradient-to-r from-emerald-600 to-teal-500 bg-clip-text text-transparent dark:from-emerald-400 dark:to-teal-300">
              on your own infrastructure
            </span>
            .
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-600 text-pretty dark:text-zinc-400">
            Reconcil matches on-chain stablecoin settlements to your invoices — partial payments,
            overpayments and network fees handled — fixes the EUR/USD value at payment date, tags
            VAT, and drafts QuickBooks/Xero journals. Every figure traces back to a transaction hash.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href={CONTACT_MAILTO}>
              Get in touch
              <ArrowIcon className="h-4 w-4" />
            </ButtonLink>
            <ButtonLink href={GITHUB_URL} variant="secondary" external>
              <GitHubIcon className="h-4 w-4" />
              View on GitHub
            </ButtonLink>
          </div>

          <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
            Early, and validating with a handful of teams. Read-only by design — no keys, no custody.
          </p>
        </div>
      </Container>
    </section>
  );
}
