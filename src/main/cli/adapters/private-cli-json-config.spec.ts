import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPrivateCliJsonConfig } from './private-cli-json-config';

describe('private CLI JSON config', () => {
  it('writes only at spawn, restricts access, and removes the file after exit', () => {
    const config = createPrivateCliJsonConfig('{"key":"PLACEHOLDER_ONLY"}');
    const path = config.argument.slice(1);
    expect(existsSync(path)).toBe(false);

    const cleanup = config.prepare();
    try {
      expect(readFileSync(path, 'utf8')).toBe('{"key":"PLACEHOLDER_ONLY"}');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    } finally {
      cleanup();
    }
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it('a late close from an earlier process cannot remove a newer process config', () => {
    const config = createPrivateCliJsonConfig('{"key":"PLACEHOLDER_ONLY"}');
    const firstCleanup = config.prepare();
    firstCleanup();
    const secondCleanup = config.prepare();
    firstCleanup();
    expect(existsSync(config.argument.slice(1))).toBe(true);
    secondCleanup();
    expect(existsSync(config.argument.slice(1))).toBe(false);
  });
});
