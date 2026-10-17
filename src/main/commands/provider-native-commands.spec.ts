import { describe, expect, it } from 'vitest';
import { nativeOpenCodeCommands, resolveNativeOpenCodeCommand } from './provider-native-commands';

describe('OpenCode ACP commands', () => {
  const adapter = { getAvailableCommands: () => [{ name: 'compact', description: 'Compact native history' }, { name: 'bad command' }] };
  it('projects only valid advertised commands with session applicability', () => {
    expect(nativeOpenCodeCommands('opencode', adapter)).toEqual([expect.objectContaining({ name: 'compact', id: 'acp:opencode:compact', execution: { type: 'prompt' }, applicability: { provider: 'opencode' } })]);
    expect(nativeOpenCodeCommands('claude', adapter)).toEqual([]);
  });
  it('resolves against the live catalog and rejects stale or invented names', () => {
    expect(resolveNativeOpenCodeCommand('opencode', adapter, 'acp:opencode:compact', ['now'])?.resolvedPrompt).toBe('/compact now');
    expect(resolveNativeOpenCodeCommand('opencode', adapter, 'acp:opencode:missing', [])).toBeUndefined();
  });
});
