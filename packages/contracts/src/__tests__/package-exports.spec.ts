import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('packages/contracts/package.json exports', () => {
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  it('has an exports field', () => {
    expect(pkg.exports).toBeDefined();
    expect(typeof pkg.exports).toBe('object');
  });

  it('does NOT expose a "." barrel', () => {
    expect(pkg.exports['.']).toBeUndefined();
  });

  it('exposes every schemas domain subpath', () => {
    for (const domain of [
      'common', 'instance', 'session', 'provider', 'orchestration',
      'settings', 'file-operations', 'security', 'observability',
      'workspace-tools', 'knowledge', 'remote-node', 'plugin', 'webhook',
    ]) {
      expect(pkg.exports[`./schemas/${domain}`]).toBeDefined();
    }
  });

  it('exposes every channels domain subpath', () => {
    for (const domain of [
      'instance', 'file', 'session', 'orchestration', 'memory',
      'provider', 'infrastructure', 'communication', 'learning', 'workspace', 'automation',
    ]) {
      expect(pkg.exports[`./channels/${domain}`]).toBeDefined();
    }
  });

  it('exposes types subpaths used by SDK', () => {
    expect(pkg.exports['./types/instance-events']).toBeDefined();
    expect(pkg.exports['./types/provider-runtime-events']).toBeDefined();
    expect(pkg.exports['./types/transport']).toBeDefined();
  });
});
