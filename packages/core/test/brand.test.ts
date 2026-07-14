import { describe, expect, it } from 'vitest';

import type { Brand } from '../src/index.js';

type RawAmount = Brand<bigint, 'RawAmount'>;

describe('Brand', () => {
  it('is erased at runtime — branded values behave as the base type', () => {
    const amount = 10n ** 18n as RawAmount;
    expect(amount + amount).toBe(2n * 10n ** 18n);
  });
});
