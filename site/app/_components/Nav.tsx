import { GITHUB_URL, SITE_NAME } from '../_lib/site';
import { Container, GitHubIcon, LogoMark } from './ui';

// Sticky, translucent top bar. Single page, so the only nav is the wordmark + GitHub.
export function Nav() {
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200/70 bg-white/80 backdrop-blur dark:border-zinc-800/70 dark:bg-zinc-950/80">
      <Container className="flex h-16 items-center justify-between">
        <a href="#top" className="flex items-center gap-2.5" aria-label={`${SITE_NAME} home`}>
          <LogoMark />
          <span className="text-lg font-semibold tracking-tight">{SITE_NAME}</span>
        </a>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub"
          className="inline-flex items-center gap-2 text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          <GitHubIcon className="h-5 w-5" />
          <span className="hidden sm:inline">GitHub</span>
        </a>
      </Container>
    </header>
  );
}
