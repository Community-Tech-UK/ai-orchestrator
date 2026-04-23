import { describe, expect, it } from 'vitest';
import { createCliAdapter, getCliDisplayName, mapSettingsToDetectionType } from '../adapter-factory';

describe('adapter factory — copilot', () => {
  it('getCliDisplayName returns GitHub Copilot', () => {
    expect(getCliDisplayName('copilot')).toBe('GitHub Copilot');
  });

  it('mapSettingsToDetectionType accepts copilot', () => {
    expect(mapSettingsToDetectionType('copilot')).toBe('copilot');
  });

  it('createCliAdapter(copilot, ...) instantiates AcpCliAdapter with a copilot provider name', () => {
    const adapter = createCliAdapter('copilot', { workingDirectory: '/tmp' });
    expect(adapter.constructor.name).toBe('AcpCliAdapter');
    expect(adapter.getName()).toBe('copilot-acp');
  });
});
