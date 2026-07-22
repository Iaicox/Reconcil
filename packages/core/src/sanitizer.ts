/**
 * Hostile on-chain / imported string scrubber (ADR-011 §1, P7). Anyone can mint a
 * token named `Ignore previous instructions …`, so provider/import strings are
 * attacker input on the path to LLM context. Pipeline: NFC normalize → allowlist
 * charset (drops controls, zero-width, bidi overrides, emoji — none are letters,
 * digits, whitespace, or safe punctuation) → collapse whitespace → length cap →
 * `(unnamed)` placeholder. Pure; `*_raw` values are never scrubbed FOR display
 * here — they stay server-side. `heavy` (>30% stripped) drives SANITIZED_HEAVY.
 * Structural isolation (the `untrusted` key) is the other layer — this scrubs the
 * charset, it does not "understand" the text.
 */

// Allowlist: letters, numbers, whitespace (\t\n\r etc., collapsed below), and a
// conservative punctuation set. Everything else — C0/C1 controls, zero-width,
// bidi overrides, word-joiner, BOM, emoji — is removed. The `u` flag makes astral
// code points (emoji) single units.
const DISALLOWED = /[^\p{L}\p{N}\s.,#/&+%$'()-]/gu;
const DEFAULT_MAX = 64;

export interface Sanitized {
  display: string;
  heavy: boolean; // > 30% of code points removed by scrubbing (SANITIZED_HEAVY)
}

export function sanitize(raw: string, opts: { maxLength?: number } = {}): Sanitized {
  const max = opts.maxLength ?? DEFAULT_MAX;
  const normalized = raw.normalize('NFC');
  const total = [...normalized].length;
  // `heavy` measures charset scrubbing only — before whitespace collapse and
  // truncation, which are normalization, not hostile-content removal.
  const scrubbed = normalized.replace(DISALLOWED, '');
  const heavy = total > 0 && (total - [...scrubbed].length) / total > 0.3;
  const collapsed = scrubbed.replace(/\s+/g, ' ').trim();
  const capped = [...collapsed].slice(0, max).join('');
  return { display: capped === '' ? '(unnamed)' : capped, heavy };
}
