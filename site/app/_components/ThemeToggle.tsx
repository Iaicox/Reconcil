'use client';

// Manual theme switch (user request, overriding the brief's system-only default — which
// still applies until the first click). Which icon shows is decided purely by the
// --show-sun/--show-moon tokens in globals.css, so the server render never mismatches the
// resolved theme: the moon is visible in light mode ("switch to dark") and vice versa.
export function ThemeToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const effective =
      root.dataset.theme ??
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = effective === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {
      // Private mode etc. — the choice still applies for this page view.
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Switch theme"
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
