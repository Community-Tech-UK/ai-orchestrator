import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readBaseline, type Baseline } from '../ui-hints/baseline.js';
import { checkLink } from '../ui-hints/lint-link';
const require = createRequire(import.meta.url);
const config = require('../../eslint.config.js');
const fixture = (): Baseline => ({ rules: Object.fromEntries(['H1a', 'H1b', 'H2a', 'H2b', 'H2c', 'H5'].map(code => [code, { 'src/renderer/a.ts': 1 }])), markers: {}, unreadable: {} });
describe('lint severity follows ratchet totals', () => {
  it('has every rule registered and accepts the actual recorded state', () => { expect(checkLink(config, readBaseline('scripts/ui-hints/baseline.json'))).toEqual([]); });
  it('rejects missing blocks, zero debt with off, and error before zero', () => {
    expect(checkLink([], fixture()).join(' ')).toContain('Missing');
    const zero = fixture(); delete zero.rules['H5']; expect(checkLink(config, zero).join(' ')).toContain('switch it on');
    expect(checkLink([...config, { rules: { 'ui-hints/no-hardcoded-shortcut': 'error' } }], fixture()).join(' ')).toContain('redden CI');
  });
  it('requires all title debt at zero before scope all', () => {
    const zero = fixture(); delete zero.rules['H2a']; delete zero.rules['H2b']; delete zero.rules['H2c'];
    expect(checkLink([...config, { rules: { 'ui-hints/no-native-title': ['error', { scope: 'controls' }] } }], zero).join(' ')).toContain('scope must be all');
    expect(checkLink([...config, { rules: { 'ui-hints/no-native-title': ['error', { scope: 'all' }] } }], zero)).toEqual([]);
  });
});
