import { describe, expect, it } from 'vitest';
import { listControlNavGroups } from './control-surface.registry';
import { searchControlNav } from './control-surface-search';

const groups = listControlNavGroups(false);
const results = (query: string) => searchControlNav(query, groups) ?? [];

describe('searchControlNav', () => {
  it('is not searching for a blank query', () => {
    expect(searchControlNav('   ', groups)).toBeNull();
  });

  it('ranks a page whose name starts with the query first', () => {
    expect(results('plan')[0].results[0]).toMatchObject({ label: 'Plan Mode', path: '/plan' });
    expect(results('plan')[0].results.map(result => result.label)).toContain('Plan Queue');
  });

  it('finds pages by their description', () => {
    expect(results('checkpoints')[0].results.map(result => result.label)).toContain('Snapshots');
  });

  it('links a Settings section by its fragment and names where a setting lives', () => {
    const settings = results('keyboard').find(group => group.id === 'settings')!.results;
    expect(settings[0]).toMatchObject({ path: '/settings', fragment: 'keyboard', queryParams: null });
    const setting = results('Context-full warning at').find(group => group.id === 'settings')!.results[0];
    expect(setting.queryParams).toEqual({ setting: 'contextWarningThreshold' });
    expect(setting.section).toMatch(/^Settings: /);
  });

  it('puts the best match first across pages, sections and single settings', () => {
    expect(results('theme')[0].results[0]).toMatchObject({ label: 'Theme', queryParams: { setting: 'theme' } });
  });

  it('does not list a Settings section that repeats a page', () => {
    const settings = results('models').find(group => group.id === 'settings')?.results ?? [];
    expect(settings.map(result => result.label)).not.toContain('Models');
    expect(results('models')[0].results.map(result => result.label)).toContain('Models');
  });

  it.each(['Microsoft 365', 'Outlook', 'mcp'])('finds connector setup by %s even when its page label differs', query => {
    expect(results(query).flatMap(group => group.results)).toContainEqual(expect.objectContaining({
      label: 'Connectors', path: '/settings', fragment: 'mcp',
    }));
  });

  it('does not offer a page the column has hidden', () => {
    expect(results('telemetry').flatMap(group => group.results).map(result => result.label)).not.toContain('Telemetry');
  });

  it('caps the settings results', () => {
    expect(results('a').find(group => group.id === 'settings')!.results).toHaveLength(12);
  });
});
