// Single source of truth for the site's external references and contact CTA.
// The mailto is the entire conversion path (validation-phase, recruiting interviews),
// so it lives here once and is imported everywhere it appears.

export const SITE_NAME = 'Reconcil';
export const SITE_TAGLINE = 'Stablecoin payment ↔ invoice reconciliation, self-hosted';
export const SITE_DESCRIPTION =
  'Reconcil is a self-hostable, MCP-native ledger that reconciles on-chain stablecoin ' +
  'payments to your invoices — partial payments, overpayments and fees handled, EUR/USD ' +
  'fixed at payment date, VAT tagged, and QuickBooks/Xero journal drafts out the other ' +
  'end. Every figure traces back to a transaction hash.';

// Project GitHub Pages URL (github.io/Reconcil/). Used for absolute OG/canonical URLs.
export const SITE_URL = 'https://iaicox.github.io/Reconcil/';
export const GITHUB_URL = 'https://github.com/Iaicox/Reconcil';
export const ARCHITECTURE_URL = `${GITHUB_URL}/tree/main/docs/architecture`;

export const CONTACT_EMAIL = 'mr.portulak@gmail.com';
export const CONTACT_SUBJECT = 'Reconcil — interview';
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(CONTACT_SUBJECT)}`;
