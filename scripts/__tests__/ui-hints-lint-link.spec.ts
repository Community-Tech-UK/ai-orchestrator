import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readBaseline, type Baseline } from '../ui-hints/baseline.js';
import { checkLink } from '../ui-hints/lint-link';
const require = createRequire(import.meta.url);
const config = require('../../eslint.config.js');
const fixture = (): Baseline => ({ rules: Object.fromEntries(['H1a', 'H1b', 'H2a', 'H2b', 'H2c', 'H5'].map(code => [code, { 'src/renderer/a.ts': 1 }])), markers: {}, unreadable: {} });
const disabledConfig = [{ rules: {
  'ui-hints/no-hardcoded-shortcut': 'off',
  'ui-hints/no-native-title': ['off', { scope: 'controls' }],
  'ui-hints/icon-control-needs-name-and-tooltip': 'off',
} }];
describe('lint severity follows ratchet totals', () => {
  it('has every rule registered and accepts the actual recorded state', () => { expect(checkLink(config, readBaseline('scripts/ui-hints/baseline.json'))).toEqual([]); });
  it('rejects missing blocks, zero debt with off, and error before zero', () => {
    expect(checkLink([], fixture()).join(' ')).toContain('Missing');
    const zero = fixture(); delete zero.rules['H5']; expect(checkLink(disabledConfig, zero).join(' ')).toContain('switch it on');
    expect(checkLink([...disabledConfig, { rules: { 'ui-hints/no-hardcoded-shortcut': 'error' } }], fixture()).join(' ')).toContain('redden CI');
  });
  it('requires the icon rule exactly when both missing-name and missing-tooltip counts are zero', () => {
    const zero = fixture(); delete zero.rules['H1a']; delete zero.rules['H1b'];
    expect(checkLink(disabledConfig, zero).join(' ')).toContain('icon-control-needs-name-and-tooltip: switch it on');
    expect(checkLink([...disabledConfig, { rules: { 'ui-hints/icon-control-needs-name-and-tooltip': 'error' } }], zero)).toEqual([]);
  });
  it('requires all title debt at zero before scope all', () => {
    const zero = fixture(); delete zero.rules['H2a']; delete zero.rules['H2b']; delete zero.rules['H2c'];
    expect(checkLink([...disabledConfig, { rules: { 'ui-hints/no-native-title': ['error', { scope: 'controls' }] } }], zero).join(' ')).toContain('scope must be all');
    expect(checkLink([...disabledConfig, { rules: { 'ui-hints/no-native-title': ['error', { scope: 'all' }] } }], zero)).toEqual([]);
  });
});
