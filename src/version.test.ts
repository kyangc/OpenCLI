import { describe, expect, it } from 'vitest';
import { IS_FORK_BUILD, PKG_VERSION } from './version.js';

describe('fork package metadata', () => {
  it('recognizes a fork build without relying on an upstream-derived version suffix', () => {
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PKG_VERSION).not.toContain('kyangc');
    expect(IS_FORK_BUILD).toBe(true);
  });
});
