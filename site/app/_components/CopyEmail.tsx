'use client';

import { useRef, useState } from 'react';

import { CONTACT_EMAIL } from '../_lib/site';

// The address in plain selectable text plus a one-click copy. `select-all` means a single
// click selects the whole address even where the clipboard API is unavailable.
export function CopyEmail({ className = '' }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CONTACT_EMAIL);
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard API (or permission denied) — the text itself stays selectable.
    }
  };

  return (
    <span className={`inline-flex items-center gap-1.5 font-mono ${className}`}>
      <span className="text-ink-2 select-all">{CONTACT_EMAIL}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy email address'}
        className="inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center text-ink-3 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        {copied ? (
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4 text-brand">
            <path
              d="M4 10.5l4 4L16 6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
            <rect x="7" y="7" width="9" height="9" stroke="currentColor" strokeWidth="1.4" />
            <path d="M13 7V4H4v9h3" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        )}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? 'Email address copied' : ''}
      </span>
    </span>
  );
}
