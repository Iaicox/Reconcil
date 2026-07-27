import { CONTACT_MAILTO, GITHUB_URL, SITE_NAME } from '../_lib/site';
import { Container, GitHubIcon, LogoMark } from './ui';

export function Footer() {
  return (
    <footer className="border-t border-zinc-200 py-12 dark:border-zinc-800">
      <Container className="flex flex-col items-center gap-6 sm:flex-row sm:justify-between">
        <div className="text-center sm:text-left">
          <div className="flex items-center justify-center gap-2 sm:justify-start">
            <LogoMark className="h-7 w-7 rounded-md" iconClassName="h-4 w-4" />
            <span className="font-semibold">{SITE_NAME}</span>
          </div>
          <p className="mt-3 max-w-md text-sm text-zinc-500 dark:text-zinc-500">
            Read-only tooling for on-chain accounting. Not financial or investment advice; journal
            entries are drafts for professional review.
          </p>
        </div>

        <div className="flex items-center gap-6 text-sm">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            <GitHubIcon className="h-4 w-4" />
            GitHub
          </a>
          <a
            href={CONTACT_MAILTO}
            className="text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Contact
          </a>
          <span className="text-zinc-500 dark:text-zinc-400">Apache-2.0</span>
        </div>
      </Container>
    </footer>
  );
}
