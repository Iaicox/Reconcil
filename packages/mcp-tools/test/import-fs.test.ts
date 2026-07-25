import { resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ToolError } from '../src/errors.js';
import { resolveConfinedPath } from '../src/recon/import-fs.js';

const BASE = resolve('/srv/imports');
const ABS_OUTSIDE = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd';

describe('resolveConfinedPath — containment against path traversal', () => {
  it('accepts a plain in-base filename', () => {
    const p = resolveConfinedPath(BASE, 'acme-2026-06.csv');
    expect(p.startsWith(BASE + sep)).toBe(true);
  });

  it('accepts a nested sub-path inside the base', () => {
    const p = resolveConfinedPath(BASE, `2026${sep}acme.csv`);
    expect(p.startsWith(BASE + sep)).toBe(true);
  });

  it('rejects a parent-directory traversal', () => {
    expect(() => resolveConfinedPath(BASE, '../secret.csv')).toThrow(ToolError);
  });

  it('rejects a deep traversal to a system file', () => {
    expect(() => resolveConfinedPath(BASE, '../../../../etc/passwd')).toThrow(ToolError);
  });

  it('rejects an absolute path outside the base', () => {
    expect(() => resolveConfinedPath(BASE, ABS_OUTSIDE)).toThrow(ToolError);
  });

  it('rejects a sibling-prefix bypass (base + "-evil")', () => {
    expect(() => resolveConfinedPath(BASE, `..${sep}imports-evil${sep}x.csv`)).toThrow(ToolError);
  });

  it('surfaces INVALID_INPUT and never leaks the path in the message', () => {
    try {
      resolveConfinedPath(BASE, '../../etc/passwd');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('INVALID_INPUT');
      // no filesystem detail leaks (finding 3): neither the base nor the target path
      expect((err as ToolError).message).not.toContain(BASE);
      expect((err as ToolError).message).not.toContain('passwd');
    }
  });
});
