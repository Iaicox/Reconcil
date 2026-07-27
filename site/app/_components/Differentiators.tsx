import type { ReactNode } from 'react';

import { Container } from './ui';

function ServerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
      <rect x="3" y="4" width="18" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3" y="13" width="18" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 7.5h.01M7 16.5h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function PlugIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
      <path d="M9 2v5M15 2v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M6 7h12v3a6 6 0 01-6 6 6 6 0 01-6-6V7z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 16v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function BadgeCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
      <path
        d="M12 2l2.4 1.8 3 .2.9 2.9 2.2 2-1 2.9 1 2.9-2.2 2-.9 2.9-3 .2L12 22l-2.4-1.8-3-.2-.9-2.9-2.2-2 1-2.9-1-2.9 2.2-2 .9-2.9 3-.2L12 2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 12l2.2 2.2L15.5 9.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
      <path
        d="M12 2l8 3v6c0 4.5-3.2 8.4-8 11-4.8-2.6-8-6.5-8-11V5l8-3z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CodeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
      <path
        d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 5l-2 14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const features: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <ServerIcon />,
    title: 'Self-hostable',
    body: 'docker compose up brings the whole stack up. Your data never leaves your infrastructure — a GDPR argument you can hand to clients.',
  },
  {
    icon: <PlugIcon />,
    title: 'MCP-native',
    body: 'A 19-tool MCP surface you drive from Claude or any compatible client, in plain language — no dashboard to learn.',
  },
  {
    icon: <BadgeCheckIcon />,
    title: 'Deterministic & auditable',
    body: 'The model never does the math. Every figure reduces to transaction hashes and tool-call IDs — citation is part of the contract.',
  },
  {
    icon: <ShieldIcon />,
    title: 'Read-only by design',
    body: 'No private keys, no custody, no trading. Built to stay on the read-only side of MiCA; journal entries are drafts for professional review.',
  },
  {
    icon: <CodeIcon />,
    title: 'Open source',
    body: 'Apache-2.0. Inspect it, run it, extend it — the ledger core and MCP server are yours to keep.',
  },
];

export function Differentiators() {
  return (
    <section className="py-20 sm:py-24">
      <Container>
        <div className="max-w-2xl">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Why it&rsquo;s different</h2>
          <p className="mt-4 text-lg text-zinc-600 dark:text-zinc-400">
            Not another hosted dashboard that holds your keys and your data. Reconcil is
            infrastructure you own.
          </p>
        </div>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-zinc-200 p-6 transition-colors hover:border-emerald-300 dark:border-zinc-800 dark:hover:border-emerald-800"
            >
              <div className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                {f.icon}
              </div>
              <h3 className="mt-4 text-lg font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{f.body}</p>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
