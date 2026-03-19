import { describe, expect, it } from 'vitest';

import { LogManager } from '../logger';

describe('LogManager', () => {
  it('truncates oversized strings and summarizes deep objects', () => {
    const manager = new LogManager({
      enableConsole: false,
      enableFile: false,
    });

    manager.log('info', 'LoggerTest', 'x'.repeat(3000), {
      payload: 'y'.repeat(6000),
      nested: {
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'too deep',
              },
            },
          },
        },
      },
      items: Array.from({ length: 30 }, (_unused, index) => index),
      buffer: Buffer.from('abc'),
    });

    const [entry] = manager.getRecentLogs({ limit: 1 });
    expect(entry.message).toContain('[truncated');
    expect(entry.data?.['payload']).toContain('[truncated');
    expect(entry.data?.['nested']).toEqual({
      level1: {
        level2: {
          level3: '[Object]',
        },
      },
    });
    expect(entry.data?.['items']).toHaveLength(26);
    expect(entry.data?.['items']).toContain('[+5 more items]');
    expect(entry.data?.['buffer']).toEqual({
      type: 'Buffer',
      length: 3,
    });
  });

  it('handles circular references without throwing', () => {
    const manager = new LogManager({
      enableConsole: false,
      enableFile: false,
    });

    const payload: Record<string, unknown> = { name: 'root' };
    payload['self'] = payload;

    manager.log('info', 'LoggerTest', 'circular payload', { payload });

    const [entry] = manager.getRecentLogs({ limit: 1 });
    expect(entry.data?.['payload']).toEqual({
      name: 'root',
      self: '[Circular]',
    });
  });
});
