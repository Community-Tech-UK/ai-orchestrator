import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildIsolatedAppServerArgs,
  CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
  CODEX_TOOL_OUTPUT_TOKEN_LIMIT_OVERRIDE,
  shouldRetryIsolatedAppServerWithoutOutputLimit,
} from './codex-app-server-spawn-policy';

describe('buildIsolatedAppServerArgs', () => {
  it('pins the AIO-owned 6000-token override ahead of app-server', () => {
    expect(CODEX_TOOL_OUTPUT_TOKEN_LIMIT).toBe(6000);
    expect(buildIsolatedAppServerArgs(true)).toEqual([
      '-c',
      'tool_output_token_limit=6000',
      'app-server',
    ]);
    expect(CODEX_TOOL_OUTPUT_TOKEN_LIMIT_OVERRIDE).toBe('tool_output_token_limit=6000');
  });

  it('omits the override on the unsupported-CLI retry', () => {
    expect(buildIsolatedAppServerArgs(false)).toEqual(['app-server']);
  });

  it('does not retry the override when the binary is missing', () => {
    expect(shouldRetryIsolatedAppServerWithoutOutputLimit({
      code: 'ENOENT',
      message: 'spawn codex ENOENT',
    })).toBe(false);
    expect(shouldRetryIsolatedAppServerWithoutOutputLimit(
      new Error('unknown override: tool_output_token_limit'),
    )).toBe(true);
  });

  it('does not pass the override on the shared broker spawn', () => {
    const brokerSource = readFileSync(
      join(__dirname, 'app-server-broker.ts'),
      'utf8',
    );
    expect(brokerSource).not.toContain('tool_output_token_limit');
    expect(brokerSource).toContain("['app-server', '--broker', '--endpoint', endpoint]");
  });
});
