import { describe, it, expect } from 'vitest';
import { mergeConfigLayers, discoverConfigFiles } from '../config-layers';

describe('config-layers', () => {
  it('project overrides system', () => {
    const merged = mergeConfigLayers({
      system: { theme: 'light', maxInstances: 10 },
      project: { maxInstances: 5 },
      user: {},
    });
    expect(merged['maxInstances']).toBe(5);
    expect(merged['theme']).toBe('light');
  });

  it('user overrides project', () => {
    const merged = mergeConfigLayers({
      system: { theme: 'light' },
      project: { theme: 'dark' },
      user: { theme: 'solarized' },
    });
    expect(merged['theme']).toBe('solarized');
  });

  it('deep merges nested objects', () => {
    const merged = mergeConfigLayers({
      system: { providers: { claude: { enabled: true, model: 'sonnet' } } },
      project: { providers: { claude: { model: 'opus' } } },
      user: {},
    });
    const providers = merged['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['claude']['enabled']).toBe(true);
    expect(providers['claude']['model']).toBe('opus');
  });

  it('arrays are replaced, not merged', () => {
    const merged = mergeConfigLayers({
      system: { tools: ['a', 'b'] },
      project: { tools: ['c'] },
      user: {},
    });
    expect(merged['tools']).toEqual(['c']);
  });

  it('handles empty layers gracefully', () => {
    const merged = mergeConfigLayers({
      system: { key: 'value' },
      project: {},
      user: {},
    });
    expect(merged['key']).toBe('value');
  });

  it('discoverConfigFiles returns null for missing files', () => {
    const result = discoverConfigFiles({
      homeDir: '/nonexistent',
      projectDir: '/nonexistent',
    });
    expect(result.project).toBeNull();
    expect(result.user).toBeNull();
    expect(result.system).toBeNull();
  });
});
