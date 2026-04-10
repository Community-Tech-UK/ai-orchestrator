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
      expect(result.errors).toContain('Missing or empty "name" field');
    }
  });

  it('rejects manifest without version', () => {
    const result = validateManifest({ name: 'test' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('Missing or empty "version" field');
    }
  });

  it('rejects non-object manifest', () => {
    const result = validateManifest('string');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('Manifest must be an object');
    }
  });

  it('rejects null manifest', () => {
    const result = validateManifest(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('Manifest must be an object');
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
      expect(result.errors).toContain('"hooks" must be an array of strings');
    }
  });

  it('collects multiple errors', () => {
    const result = validateManifest({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('Missing or empty "name" field');
      expect(result.errors).toContain('Missing or empty "version" field');
    }
  });

  it('filters non-string values out of hooks array', () => {
    const result = validateManifest({
      name: 'test',
      version: '1.0.0',
      hooks: ['instance.created', 42, null, 'instance.removed'],
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.hooks).toEqual(['instance.created', 'instance.removed']);
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
      expect(result.errors).toContain('Missing or empty "name" field');
    }
  });

  it('rejects manifest with empty version string', () => {
    const result = validateManifest({ name: 'test', version: '' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('Missing or empty "version" field');
    }
  });
});
