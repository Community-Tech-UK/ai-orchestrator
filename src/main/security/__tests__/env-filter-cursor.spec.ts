import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSafeEnvForTrustedProcess } from '../env-filter';

describe('env-filter — cursor', () => {
  const original = process.env['CURSOR_API_KEY'];
  beforeEach(() => { process.env['CURSOR_API_KEY'] = 'sk-test'; });
  afterEach(() => {
    if (original === undefined) delete process.env['CURSOR_API_KEY'];
    else process.env['CURSOR_API_KEY'] = original;
  });

  it('CURSOR_API_KEY survives filter to reach the Cursor child process', () => {
    const env = getSafeEnvForTrustedProcess();
    expect(env['CURSOR_API_KEY']).toBe('sk-test');
  });
});

describe('env-filter — getSafeEnvForTrustedProcess preserves provider keys (regression)', () => {
  const originalAnthropic = process.env['ANTHROPIC_API_KEY'];
  beforeEach(() => { process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'; });
  afterEach(() => {
    if (originalAnthropic === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = originalAnthropic;
  });

  it('ANTHROPIC_API_KEY survives — explicit allowlist overrides blocklist', () => {
    const env = getSafeEnvForTrustedProcess();
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-test');
  });
});
