import { describe, it, expect } from 'vitest';
import { createCliAdapter, getCliDisplayName, mapSettingsToDetectionType } from '../adapter-factory';

describe('adapter factory — cursor', () => {
  it('getCliDisplayName returns Cursor CLI', () => {
    expect(getCliDisplayName('cursor')).toBe('Cursor CLI');
  });
  it('mapSettingsToDetectionType accepts cursor', () => {
    expect(mapSettingsToDetectionType('cursor')).toBe('cursor');
  });
  it('createCliAdapter(cursor, ...) instantiates AcpCliAdapter with a cursor provider name', () => {
    const adapter = createCliAdapter('cursor', { workingDirectory: '/tmp' });
    expect(adapter.constructor.name).toBe('AcpCliAdapter');
    expect(adapter.getName()).toBe('cursor-acp');
  });

  it('passes resume session options through to the ACP adapter', () => {
    const adapter = createCliAdapter('cursor', {
      workingDirectory: '/tmp',
      resume: true,
      sessionId: 'cursor-session-1',
    });
    expect((adapter as unknown as {
      acpConfig: { resume?: boolean; sessionId?: string };
    }).acpConfig).toMatchObject({
      resume: true,
      sessionId: 'cursor-session-1',
    });
  });
});
