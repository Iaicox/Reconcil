import type { ReactNode, SVGProps } from 'react';

// Consistent page gutter + max width for every section (comps: 1152px content, 40px gutter
// on desktop, 20px on mobile).
export function Container({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-5 sm:px-10 ${className}`}>{children}</div>;
}

type ButtonLinkProps = {
  href: string;
  children: ReactNode;
  external?: boolean;
  className?: string;
};

// The one action treatment: a sharp-cornered brand-green rectangle, mono label. CTAs are
// plain links (mailto / GitHub); the only client JS on the page is the theme toggle and the
// copy-email affordance. Height/padding come from the call site (hero 46px, mobile 50px in
// the comps).
export function ButtonLink({ href, children, external = false, className = '' }: ButtonLinkProps) {
  const rel = external ? 'noopener noreferrer' : undefined;
  const target = external ? '_blank' : undefined;
  return (
    <a
      href={href}
      target={target}
      rel={rel}
      className={
        'inline-flex flex-none items-center justify-center whitespace-nowrap bg-brand ' +
        'font-mono font-semibold text-white transition-colors hover:bg-brand-hover ' +
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ' +
        className
      }
    >
      {children}
    </a>
  );
}

// Secondary path: an underlined mono text link ("or email instead").
export function RuledLink({ href, children, className = '' }: Omit<ButtonLinkProps, 'external'>) {
  return (
    <a
      href={href}
      className={
        'flex-none whitespace-nowrap border-b border-dr pb-0.5 font-mono text-ink-2 ' +
        'transition-colors hover:border-ink hover:text-ink ' +
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ' +
        className
      }
    >
      {children}
    </a>
  );
}

// The double rule that closes a balanced ledger page — the system's recurring motif
// (4px tall: two 1px rules with a 2px gap).
export function DoubleRule({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`h-1 border-y border-dr ${className}`} />;
}

// The Reconcil mark, decided in the mark sheet round 8b: an Instrument Sans R over a double
// rule tilted 8° — ruled by a hand, closing a balanced page. Optical tune from the comps:
// letter at 49%/42%, rules one grid unit right, stroke a constant 1px on screen (64/size in
// viewBox units). Also rendered standalone as the file-based favicon at app/icon.svg — keep
// that file in sync if the mark ever changes.
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <span
      className="relative block flex-none overflow-hidden rounded-[23.4%] bg-tile"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span
        className="absolute top-[42%] left-[49%] -translate-x-1/2 -translate-y-1/2 font-sans font-bold tracking-[-0.03em] text-tile-ink"
        style={{ fontSize: size * 0.547, lineHeight: 1 }}
      >
        R
      </span>
      <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full">
        <g fill="none" stroke="var(--tile-ink)" opacity=".62">
          <path d="M18 53L48 49M18 48L48 44" strokeWidth={64 / size} strokeLinecap="round" />
        </g>
      </svg>
    </span>
  );
}

export function GitHubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.339-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .268.18.58.688.482A10.02 10.02 0 0022 12.017C22 6.484 17.523 2 12 2z"
      />
    </svg>
  );
}
