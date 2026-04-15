import { describe, it, expect } from 'vitest';
import { validateManifest } from '../plugin-manager.js';

describe('manifest validation', () => {
  it('validates a correct manifest', () => {
    const result = validateManifest({ name: 'test', version: '1.0.0' });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.name).toBe('test');
      expect(result.manifest.version).toBe('1.0.0');
    }
  });

  it('rejects manifest without name', () => {
    const result = validateManifest({ version: '1.0.0' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.toLowerCase().includes('name'))).toBe(true);
    }
  });

  it('rejects manifest without version', () => {
    const result = validateManifest({ name: 'test' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.toLowerCase().includes('version'))).toBe(true);
    }
  });

  it('rejects non-object manifest', () => {
    const result = validateManifest('string');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects null manifest', () => {
    const result = validateManifest(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('accepts optional fields', () => {
    const result = validateManifest({
      name: 'test',
      version: '1.0.0',
      description: 'Desc',
      author: 'Me',
      hooks: ['instance.created'],
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.description).toBe('Desc');
      expect(result.manifest.author).toBe('Me');
      expect(result.manifest.hooks).toEqual(['instance.created']);
    }
  });

  it('rejects non-array hooks', () => {
    const result = validateManifest({ name: 'test', version: '1.0.0', hooks: 'not-array' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.toLowerCase().includes('hook'))).toBe(true);
    }
  });

  it('collects multiple errors', () => {
    const result = validateManifest({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
      expect(result.errors.some((e) => e.toLowerCase().includes('name'))).toBe(true);
      expect(result.errors.some((e) => e.toLowerCase().includes('version'))).toBe(true);
    }
  });

  it('rejects hooks array containing non-string values', () => {
    // The Zod schema validates hook values as known event names.
    // Non-string values (42, null) are rejected rather than silently filtered.
    const result = validateManifest({
      name: 'test',
      version: '1.0.0',
      hooks: ['instance.created', 42, null, 'instance.removed'],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('sets optional fields to undefined when absent', () => {
    const result = validateManifest({ name: 'test', version: '1.0.0' });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.description).toBeUndefined();
      expect(result.manifest.author).toBeUndefined();
      expect(result.manifest.hooks).toBeUndefined();
    }
  });

  it('rejects manifest with empty name string', () => {
    const result = validateManifest({ name: '', version: '1.0.0' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.toLowerCase().includes('name'))).toBe(true);
    }
  });

  it('rejects manifest with empty version string', () => {
    const result = validateManifest({ name: 'test', version: '' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.toLowerCase().includes('version'))).toBe(true);
    }
  });

  it('rejects manifest with non-semver version', () => {
    const result = validateManifest({ name: 'test', version: 'beta' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.toLowerCase().includes('version'))).toBe(true);
    }
  });

  it('rejects unknown hook event names', () => {
    const result = validateManifest({
      name: 'test',
      version: '1.0.0',
      hooks: ['not.a.real.hook'],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.toLowerCase().includes('hook'))).toBe(true);
    }
  });
});
