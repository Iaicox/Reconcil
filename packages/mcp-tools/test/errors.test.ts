import { describe, expect, it } from 'vitest';

import { ToolError } from '../src/errors.js';

describe('ToolError — cause hygiene', () => {
  it('keeps message/hint independent of cause; cause never appears in message', () => {
    const secret = new Error('EACCES: permission denied, open \'/abs/host/path/secret.csv\'');
    const err = new ToolError('INTERNAL', 'export_close_pack failed to write export files', undefined, secret);

    expect(err.message).toBe('export_close_pack failed to write export files');
    expect(err.message).not.toContain('EACCES');
    expect(err.message).not.toContain('/abs/host/path');
    expect(err.cause).toBe(secret);
    expect(err.code).toBe('INTERNAL');
  });

  it('omits cause entirely when not given (existing 3-arg call sites keep working)', () => {
    const err = new ToolError('INVALID_INPUT', 'unknown match_id: abc', 'call recon_suggest_matches first');
    expect(err.cause).toBeUndefined();
    expect(err.hint).toBe('call recon_suggest_matches first');
  });
});
