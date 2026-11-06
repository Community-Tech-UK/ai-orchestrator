import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claudeNativeToolSearch,
  type ClaudeNativeToolSearchInput,
} from './claude-native-tool-search';

function detect(input: ClaudeNativeToolSearchInput) {
  return claudeNativeToolSearch({ processEnv: {}, ...input });
}

describe('claudeNativeToolSearch', () => {
  beforeEach(() => {
    vi.stubEnv('ENABLE_TOOL_SEARCH', '');
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('true and auto:0 are on', () => {
    expect(detect({ env: { ENABLE_TOOL_SEARCH: 'true' } })).toBe('on');
    expect(detect({ env: { ENABLE_TOOL_SEARCH: 'auto:0' } })).toBe('on');
    expect(detect({ settingsEnv: { ENABLE_TOOL_SEARCH: 'true' } })).toBe('on');
    expect(detect({ settingsEnv: { ENABLE_TOOL_SEARCH: 'auto:0' } })).toBe('on');
  });

  it('auto and auto:N are unknown — size-threshold deferral is not guaranteed', () => {
    expect(detect({ env: { ENABLE_TOOL_SEARCH: 'auto' } })).toBe('unknown');
    expect(detect({ env: { ENABLE_TOOL_SEARCH: 'auto:10' } })).toBe('unknown');
  });

  it('false, 0 and off are off', () => {
    expect(detect({ env: { ENABLE_TOOL_SEARCH: 'false' } })).toBe('off');
    expect(detect({ env: { ENABLE_TOOL_SEARCH: '0' } })).toBe('off');
    expect(detect({ env: { ENABLE_TOOL_SEARCH: 'off' } })).toBe('off');
  });

  it('unset is unknown', () => {
    expect(detect({})).toBe('unknown');
  });

  it('spawn env beats settings env', () => {
    expect(
      detect({
        env: { ENABLE_TOOL_SEARCH: 'auto:0' },
        settingsEnv: { ENABLE_TOOL_SEARCH: 'false' },
      }),
    ).toBe('on');
    expect(
      detect({
        env: { ENABLE_TOOL_SEARCH: 'false' },
        settingsEnv: { ENABLE_TOOL_SEARCH: 'auto:0' },
      }),
    ).toBe('off');
  });

  it('a custom non-Anthropic base URL is off unless the flag is exactly true', () => {
    expect(
      detect({
        env: { ENABLE_TOOL_SEARCH: 'auto:0', ANTHROPIC_BASE_URL: 'https://proxy.example.com/v1' },
      }),
    ).toBe('off');
    expect(
      detect({
        env: { ENABLE_TOOL_SEARCH: 'true', ANTHROPIC_BASE_URL: 'https://proxy.example.com/v1' },
      }),
    ).toBe('on');
    expect(
      detect({
        env: { ENABLE_TOOL_SEARCH: 'auto:0', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      }),
    ).toBe('on');
  });

  it('a Haiku model is off even with the flag on', () => {
    expect(detect({ model: 'claude-haiku-4-5', env: { ENABLE_TOOL_SEARCH: 'auto:0' } })).toBe('off');
    expect(detect({ model: 'Claude-Haiku-3', env: { ENABLE_TOOL_SEARCH: 'true' } })).toBe('off');
    expect(detect({ model: 'claude-sonnet-4-5', env: { ENABLE_TOOL_SEARCH: 'auto:0' } })).toBe('on');
  });

  it('reads the flag from settings env when the spawn env is silent', () => {
    expect(detect({ settingsEnv: { ENABLE_TOOL_SEARCH: 'auto:0' } })).toBe('on');
    expect(detect({ processEnv: { ENABLE_TOOL_SEARCH: 'false' } })).toBe('off');
  });
});
