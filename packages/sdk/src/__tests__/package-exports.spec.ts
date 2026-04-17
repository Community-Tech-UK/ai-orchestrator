import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('packages/sdk/package.json exports', () => {
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  it('has an exports field', () => {
    expect(pkg.exports).toBeDefined();
    expect(typeof pkg.exports).toBe('object');
  });

  it('does NOT expose a "." barrel', () => {
    expect(pkg.exports['.']).toBeUndefined();
  });

  it('exposes tools, plugins, providers', () => {
    expect(pkg.exports['./tools']).toBeDefined();
    expect(pkg.exports['./plugins']).toBeDefined();
    expect(pkg.exports['./providers']).toBeDefined();
  });
});
