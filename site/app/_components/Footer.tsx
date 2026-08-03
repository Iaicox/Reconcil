import { GITHUB_URL, SITE_NAME } from '../_lib/site';
import { CopyEmail } from './CopyEmail';
import { Container, GitHubIcon, LogoMark } from './ui';

export function Footer() {
  return (
    <footer className="border-t border-rule py-12">
      <Container className="flex flex-col items-center gap-6 sm:flex-row sm:justify-between">
        <div className="text-center sm:text-left">
          <div className="flex items-center justify-center gap-2 sm:justify-start">
            <LogoMark size={28} />
            <span className="font-semibold tracking-[-0.025em]">{SITE_NAME}</span>
          </div>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-3">
            Read-only tooling for on-chain accounting. Not financial or investment advice; journal
            entries are drafts for professional review.
          </p>
        </div>

        <div className="flex items-center gap-6 text-sm">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-ink-2 transition-colors hover:text-ink"
          >
            <GitHubIcon className="h-4 w-4" />
            GitHub
          </a>
          <CopyEmail className="text-[13px]" />
          <span className="font-mono text-[13px] text-ink-3">Apache-2.0</span>
        </div>
      </Container>
    </footer>
  );
}
