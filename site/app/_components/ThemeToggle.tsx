'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

// Paper tokens from globals.css — keep in sync if the palette ever changes.
const THEME_COLORS: Record<Theme, string> = { light: '#f1f4f0', dark: '#0a0d0b' };

// The media-scoped <meta name="theme-color"> pair follows the system; a manual choice has
// to overwrite both entries or the browser chrome would disagree with the page.
function syncThemeColorMeta(theme: Theme) {
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.setAttribute('content', THEME_COLORS[theme]);
  });
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Manual theme switch (user request, overriding the brief's system-only default — which
// still applies until the first click). Which icon shows is decided purely by the
// --show-sun/--show-moon tokens in globals.css, so the server render never mismatches the
// resolved theme: the moon is visible in light mode ("switch to dark") and vice versa.
// The effective theme lands in React state only after mount (post-hydration, so no
// mismatch) to give the button a state-aware accessible name.
export function ThemeToggle() {
  const [effective, setEffective] = useState<Theme | null>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const compute = () =>
      (document.documentElement.dataset.theme as Theme | undefined) ?? systemTheme();
    // Reads `document`/matchMedia, which don't exist at SSR time — the value cannot be
    // computed during render without a server/client mismatch, so this is the intentional
    // "synchronize with an external system" case the rule doesn't distinguish from derived
    // state; see the component doc comment above for why it lands post-mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEffective(compute());
    const onChange = () => setEffective(compute());
    mq.addEventListener('change', onChange);
    // The nav renders two instances (desktop bar / mobile cluster); watching the attribute
    // keeps the one you didn't click labelled correctly.
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', onChange);
      observer.disconnect();
    };
  }, []);

  const toggle = () => {
    const next: Theme = (effective ?? systemTheme()) === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setEffective(next);
    syncThemeColorMeta(next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      // Private mode etc. — the choice still applies for this page view.
    }
  };

  const label = effective
    ? `Switch to ${effective === 'dark' ? 'light' : 'dark'} theme`
    : 'Switch theme';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      className="inline-flex h-10 w-10 flex-none cursor-pointer items-center justify-center text-ink-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      <span aria-hidden="true" style={{ display: 'var(--show-moon)' }}>
        <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]">
          <path
            d="M20.3 14.6A8.3 8.3 0 019.4 3.7a8.3 8.3 0 1010.9 10.9z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span aria-hidden="true" style={{ display: 'var(--show-sun)' }}>
        <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]">
          <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M12 2.8v2M12 19.2v2M21.2 12h-2M4.8 12h-2M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4M18.5 18.5l-1.4-1.4M6.9 6.9L5.5 5.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </span>
    </button>
  );
}
