import { describe, expect, it } from 'vitest';
import { resolveFileIcon, SETI_DEFAULT_ICON } from './file-icon';
import {
  SETI_EXTENSION_ICONS,
  SETI_FILENAME_ICONS,
} from './file-icon-map.generated';

describe('resolveFileIcon', () => {
  it('resolves plain extensions to their Seti icon (colour identifies the type)', () => {
    // Colours come straight from the vendored Seti theme. If upstream changes
    // these, regenerate the map — the point here is that resolution reaches the
    // right definition, not that any specific hex is eternal.
    expect(resolveFileIcon('main.ts').color).toBe('#519aba');
    expect(resolveFileIcon('app.html').color).toBe('#e37933');
    expect(resolveFileIcon('styles.scss').color).toBe('#f55385');
    expect(resolveFileIcon('theme.css').color).toBe('#519aba');
    expect(resolveFileIcon('data.json').color).toBe('#cbcb41');
    expect(resolveFileIcon('README.md').color).toBe('#519aba');
    expect(resolveFileIcon('script.js').color).toBe('#cbcb41');
    expect(resolveFileIcon('run.py').color).toBe('#519aba');
    expect(resolveFileIcon('Main.java').color).toBe('#cc3e44');
    expect(resolveFileIcon('logo.svg').color).toBe('#a074c4');
    expect(resolveFileIcon('pic.png').color).toBe('#a074c4');
    expect(resolveFileIcon('config.yml').color).toBe('#a074c4');
  });

  it('returns the same def object the generated map holds for an extension', () => {
    expect(resolveFileIcon('a.ts')).toBe(SETI_EXTENSION_ICONS['ts']);
    expect(resolveFileIcon('a.svg')).toBe(SETI_EXTENSION_ICONS['svg']);
  });

  it('prefers the longest compound extension (spec.ts differs from ts)', () => {
    const specTs = resolveFileIcon('button.spec.ts');
    const plainTs = resolveFileIcon('button.ts');
    expect(specTs.color).toBe('#e37933'); // typescript "test" variant, orange
    expect(plainTs.color).toBe('#519aba'); // plain typescript, blue
    expect(specTs).not.toBe(plainTs);
    expect(specTs).toBe(SETI_EXTENSION_ICONS['spec.ts']);
  });

  it('matches exact filenames before falling back to extensions', () => {
    // Dockerfile has no extension; it resolves via the filename map (docker glyph).
    expect(resolveFileIcon('Dockerfile')).toBe(SETI_FILENAME_ICONS['dockerfile']);
    // package.json has no special filename entry — it resolves via the .json
    // extension (VS Code Seti behaviour: yellow JSON glyph).
    expect(resolveFileIcon('package.json')).toBe(SETI_EXTENSION_ICONS['json']);
  });

  it('is case-insensitive for both filename and extension matches', () => {
    expect(resolveFileIcon('DOCKERFILE')).toBe(SETI_FILENAME_ICONS['dockerfile']);
    expect(resolveFileIcon('Component.TS')).toBe(SETI_EXTENSION_ICONS['ts']);
    expect(resolveFileIcon('IMAGE.PNG')).toBe(SETI_EXTENSION_ICONS['png']);
  });

  it('uses only the basename of a nested path', () => {
    expect(resolveFileIcon('src/renderer/app/main.ts')).toBe(SETI_EXTENSION_ICONS['ts']);
    expect(resolveFileIcon('deep/nested/dir/button.spec.ts')).toBe(SETI_EXTENSION_ICONS['spec.ts']);
    // Windows-style separators too.
    expect(resolveFileIcon('src\\app\\Main.java')).toBe(SETI_EXTENSION_ICONS['java']);
  });

  it('falls back to the default glyph for unknown extensions and empty input', () => {
    expect(resolveFileIcon('mystery.zzzzz')).toBe(SETI_DEFAULT_ICON);
    expect(resolveFileIcon('noextension')).toBe(SETI_DEFAULT_ICON);
    expect(resolveFileIcon('')).toBe(SETI_DEFAULT_ICON);
    expect(resolveFileIcon('some/dir/')).toBe(SETI_DEFAULT_ICON);
  });

  it('emits a non-empty single-code-point glyph for every mapped entry', () => {
    for (const def of Object.values(SETI_EXTENSION_ICONS)) {
      expect(def.glyph.length).toBeGreaterThan(0);
      expect(def.color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    }
    expect(SETI_DEFAULT_ICON.glyph.length).toBeGreaterThan(0);
  });
});
