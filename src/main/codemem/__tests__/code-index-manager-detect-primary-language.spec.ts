import { describe, expect, it } from 'vitest';
import { CodeIndexManager } from '../code-index-manager';
import type { CasStore } from '../cas-store';

class TestableCodeIndexManager extends CodeIndexManager {
  detect(files: string[]): string | null {
    return this.detectPrimaryLanguage(files);
  }
}

function buildManager(): TestableCodeIndexManager {
  return new TestableCodeIndexManager({ store: {} as CasStore });
}

function filesWithExtension(count: number, extension: string): string[] {
  return Array.from({ length: count }, (_, index) => `/repo/file-${index}${extension}`);
}

describe('CodeIndexManager.detectPrimaryLanguage', () => {
  it('ignores unknown file types so TypeScript outvotes JSON fixtures', () => {
    const manager = buildManager();
    const files = [
      ...filesWithExtension(100, '.ts'),
      ...filesWithExtension(200, '.json'),
    ];

    expect(manager.detect(files)).toBe('typescript');
  });

  it('returns null when no recognized code files are present', () => {
    const manager = buildManager();
    const files = [
      ...filesWithExtension(20, '.json'),
      ...filesWithExtension(10, '.md'),
    ];

    expect(manager.detect(files)).toBeNull();
  });

  it('returns the most common recognized language', () => {
    const manager = buildManager();
    const files = [
      ...filesWithExtension(10, '.ts'),
      ...filesWithExtension(5, '.py'),
    ];

    expect(manager.detect(files)).toBe('typescript');
  });

  it('returns null for an empty file list', () => {
    const manager = buildManager();

    expect(manager.detect([])).toBeNull();
  });
});
