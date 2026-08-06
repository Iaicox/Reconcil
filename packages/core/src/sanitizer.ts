/**
 * Hostile on-chain / imported string scrubber (ADR-011 §1, P7). Anyone can mint a
 * token named `Ignore previous instructions …`, so provider/import strings are
 * attacker input on the path to LLM context. Pipeline: NFC normalize → allowlist
 * charset (drops controls, zero-width, bidi overrides, emoji — none are letters,
 * digits, whitespace, or safe punctuation) → collapse whitespace → length cap →
 * `(unnamed)` placeholder. Pure; `*_raw` values are never scrubbed FOR display
 * here — they stay server-side. Structural isolation (the `untrusted` key) is the
 * other layer — this scrubs the charset, it does not "understand" the text.
 *
 * `heavy` (drives SANITIZED_HEAVY, 02-mcp-contracts §7) fires when the charset scrub
 * AND/OR the length cap together removed more than 30% of the ORIGINAL (post-NFC,
 * pre-scrub) code points. Both are real content loss the agent should be told about —
 * a 10 000-char all-letters name silently cut to 64 chars is a 99% loss that used to
 * report `heavy: false` just because nothing hostile was in the charset. Whitespace
 * COLLAPSE is deliberately excluded from both terms (measured pre-collapse for the
 * charset term, and the truncation term only counts what the cap itself removed) —
 * collapsing "A   B" to "A B" is normalization, not hostile-content removal, and must
 * not count toward the threshold.
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
  const scrubbed = normalized.replace(DISALLOWED, '');
  const scrubbedLen = [...scrubbed].length;
  const collapsed = scrubbed.replace(/\s+/g, ' ').trim();
  const collapsedLen = [...collapsed].length;
  const cappedArr = [...collapsed].slice(0, max);
  const capped = cappedArr.join('');

  const charsetRemoved = total - scrubbedLen; // hostile charset stripped
  const truncatedRemoved = collapsedLen - cappedArr.length; // content cut by the length cap
  const heavy = total > 0 && (charsetRemoved + truncatedRemoved) / total > 0.3;

  return { display: capped === '' ? '(unnamed)' : capped, heavy };
}
