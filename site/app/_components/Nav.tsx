import { ARCHITECTURE_URL, CONTACT_MAILTO, GITHUB_URL, SITE_NAME } from '../_lib/site';
import { ButtonLink, Container, LogoMark } from './ui';

const links = [
  { href: ARCHITECTURE_URL, label: 'Architecture' },
  { href: GITHUB_URL, label: 'Repository' },
];

const linkClass =
  'font-mono text-xs uppercase tracking-[0.07em] text-ink-2 transition-colors hover:text-ink ' +
  'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink';

// Sticky top bar on the page rule. Desktop: two repo links + the interview CTA. Mobile: a
// 44px hamburger opening a no-JS <details> panel with the same three destinations.
export function Nav() {
  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-paper">
      <Container className="relative flex h-[58px] items-center justify-between md:h-[68px]">
        <a
          href="#top"
          className="flex items-center gap-[9px] focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink md:gap-[11px]"
          aria-label={`${SITE_NAME} home`}
        >
          <span className="md:hidden">
            <LogoMark size={28} />
          </span>
          <span className="hidden md:block">
            <LogoMark size={32} />
          </span>
          <span className="text-[16.5px] font-semibold tracking-[-0.025em] md:text-lg">
            {SITE_NAME}
          </span>
        </a>

        <nav className="hidden items-center gap-[30px] md:flex">
          {links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
              {l.label}
            </a>
          ))}
          <ButtonLink href={CONTACT_MAILTO} className="h-10 px-[18px] text-[13px] tracking-[0.02em]">
            Book 20 minutes
          </ButtonLink>
        </nav>

        <details className="md:hidden">
          <summary
            aria-label="Menu"
            className="-mr-2.5 flex h-11 w-11 cursor-pointer list-none items-center justify-center [&::-webkit-details-marker]:hidden"
          >
            <span className="flex w-[18px] flex-col gap-1">
              <span className="h-[1.5px] bg-ink-2" />
              <span className="h-[1.5px] bg-ink-2" />
            </span>
          </summary>
          <div className="absolute inset-x-0 top-full border-b border-rule bg-paper">
            <div className="flex flex-col px-5 pt-2 pb-5">
              {links.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${linkClass} py-3`}
                >
                  {l.label}
                </a>
              ))}
              <ButtonLink href={CONTACT_MAILTO} className="mt-3 h-[50px] w-full text-sm">
                Book 20 minutes
              </ButtonLink>
            </div>
          </div>
        </details>
      </Container>
    </header>
  );
}
