import type { Metadata } from 'next';
import { IBM_Plex_Mono, Instrument_Sans } from 'next/font/google';

import './globals.css';
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, SITE_URL } from './_lib/site';

// next/font self-hosts both faces into the static export — no runtime request to Google,
// which is on-message for a self-hostable product. Instrument Sans explains; IBM Plex Mono
// is the voice of the ledger — every figure, hash, status and column head.
const instrument = Instrument_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-instrument',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-plex-mono',
});

const title = `${SITE_NAME} — ${SITE_TAGLINE}`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title,
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: 'website',
    title,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    siteName: SITE_NAME,
  },
  twitter: {
    card: 'summary',
    title,
    description: SITE_DESCRIPTION,
  },
};

// Runs parser-blocking before anything paints: re-applies a theme the visitor chose with
// the nav toggle (data-theme on <html> + localStorage). Also owns the theme-color metas —
// they are created here, NOT via the Next viewport export, because React re-applies
// viewport-owned metas during hydration and would undo a manual-theme override (ThemeToggle
// rewrites their content on click). Without JS there is simply no theme-color meta.
// Without a stored choice the page keeps following prefers-color-scheme — see globals.css.
const themeInit =
  `try{var d=document,h=d.head;` +
  `function m(md,c){var e=d.createElement("meta");e.name="theme-color";e.media=md;e.content=c;h.appendChild(e);return e}` +
  `var a=m("(prefers-color-scheme: light)","#f1f4f0"),b=m("(prefers-color-scheme: dark)","#0a0d0b");` +
  `var t=localStorage.getItem("theme");` +
  `if(t==="light"||t==="dark"){d.documentElement.dataset.theme=t;` +
  `var c=t==="dark"?"#0a0d0b":"#f1f4f0";a.content=c;b.content=c}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${instrument.variable} ${plexMono.variable}`}>
      <body className="bg-paper font-sans text-ink antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        {children}
      </body>
    </html>
  );
}
