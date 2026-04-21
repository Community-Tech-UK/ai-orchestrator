import { describe, it, expect } from 'vitest';
import { createCliAdapter, getCliDisplayName, mapSettingsToDetectionType } from '../adapter-factory';

describe('adapter factory — cursor', () => {
  it('getCliDisplayName returns Cursor CLI', () => {
    expect(getCliDisplayName('cursor')).toBe('Cursor CLI');
  });
  it('mapSettingsToDetectionType accepts cursor', () => {
    expect(mapSettingsToDetectionType('cursor')).toBe('cursor');
  });
  it('createCliAdapter(cursor, ...) instantiates CursorCliAdapter', () => {
    const adapter = createCliAdapter('cursor', { workingDirectory: '/tmp' });
    expect(adapter.constructor.name).toBe('CursorCliAdapter');
  });
});
