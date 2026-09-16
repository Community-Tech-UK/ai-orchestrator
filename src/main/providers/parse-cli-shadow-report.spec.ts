import { describe, expect, it } from 'vitest';
import { parseCliShadowReport } from './provider-runtime-registry';

describe('parseCliShadowReport', () => {
  it('accepts a well-formed shadow report', () => {
    expect(parseCliShadowReport({
      cli: 'claude',
      installs: [
        { path: '/usr/bin/claude', installed: true, version: '1.2.3' },
      ],
      activePath: '/usr/bin/claude',
      activeVersion: '1.2.3',
    })).toEqual({
      cli: 'claude',
      installs: [
        { path: '/usr/bin/claude', installed: true, version: '1.2.3' },
      ],
      activePath: '/usr/bin/claude',
      activeVersion: '1.2.3',
    });
  });

  it('rejects malformed metadata instead of casting it', () => {
    expect(parseCliShadowReport(null)).toBeUndefined();
    expect(parseCliShadowReport({ cli: 'claude' })).toBeUndefined();
    expect(parseCliShadowReport({
      cli: 'claude',
      installs: [{ path: 12, installed: true }],
    })).toBeUndefined();
  });
});
