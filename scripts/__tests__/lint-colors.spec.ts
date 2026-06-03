/**
 * lint-colors.spec.ts
 *
 * Unit tests for the lint-colors.js color-scanner helpers.
 *
 * We test the exported scanFile() and isAllowlistedLine() functions by
 * writing a temporary file or exercising the helpers with in-memory content
 * to avoid touching the real source tree.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const require = createRequire(import.meta.url);
const { scanFile, isAllowlistedLine } = require('../lint-colors.js') as {
  scanFile: (
    filePath: string,
  ) => Array<{ file: string; line: number; col: number; match: string; pattern: string }>;
  isAllowlistedLine: (line: string) => boolean;
};

// ── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

function writeTmp(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-colors-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── isAllowlistedLine ──────────────────────────────────────────────────────

describe('isAllowlistedLine', () => {
  it('allows SCSS line comments', () => {
    expect(isAllowlistedLine('  // --primary-color: #b89a66;')).toBe(true);
  });

  it('allows block comment continuation lines', () => {
    expect(isAllowlistedLine('   * Some doc mentioning #ff0000')).toBe(true);
  });

  it('allows block comment open', () => {
    expect(isAllowlistedLine('/* color: #ff0000 */')).toBe(true);
  });

  it('allows inline SVG data URI lines', () => {
    expect(isAllowlistedLine(`background: url("data:image/svg+xml,%3Csvg fill='%23fff'`)).toBe(true);
  });

  it('allows any data: URI line', () => {
    expect(isAllowlistedLine(`content: url('data:image/png;base64,abc')`)).toBe(true);
  });

  it('does NOT allow plain SCSS with a raw hex', () => {
    expect(isAllowlistedLine('  color: #ff0000;')).toBe(false);
  });

  it('does NOT allow template expressions with raw hex', () => {
    expect(isAllowlistedLine('const c = `color: #abc`;')).toBe(false);
  });
});

// ── scanFile ──────────────────────────────────────────────────────────────

describe('scanFile — hex detection', () => {
  it('flags a 6-digit hex color in a SCSS file', () => {
    const f = writeTmp('a.scss', `.btn { color: #ff0000; }\n`);
    const findings = scanFile(f);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].match).toBe('#ff0000');
    expect(findings[0].pattern).toBe('hex-6');
    expect(findings[0].line).toBe(1);
  });

  it('flags a 3-digit hex color', () => {
    const f = writeTmp('b.scss', `.x { background: #abc; }\n`);
    const findings = scanFile(f);
    expect(findings.some((x) => x.match === '#abc')).toBe(true);
  });

  it('flags an 8-digit hex color', () => {
    const f = writeTmp('c.scss', `.x { background: #ff000088; }\n`);
    const findings = scanFile(f);
    expect(findings.some((x) => x.pattern === 'hex-8')).toBe(true);
  });

  it('flags rgb() usage', () => {
    const f = writeTmp('d.ts', `const c = 'color: rgb(255, 0, 0)';`);
    const findings = scanFile(f);
    expect(findings.some((x) => x.pattern === 'rgb')).toBe(true);
  });

  it('flags rgba() usage', () => {
    const f = writeTmp('e.ts', `const c = 'color: rgba(255, 0, 0, 0.5)';`);
    const findings = scanFile(f);
    expect(findings.some((x) => x.pattern === 'rgb')).toBe(true);
  });
});

describe('scanFile — token and comment exemptions', () => {
  it('does NOT flag a CSS custom-property token reference', () => {
    const f = writeTmp('f.scss', `color: var(--status-error);\n`);
    const findings = scanFile(f);
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag a line-commented hex', () => {
    const f = writeTmp('g.scss', `// color: #ff0000;\n`);
    const findings = scanFile(f);
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag an inline SVG data URI containing hex', () => {
    const f = writeTmp('h.scss', `background-image: url("data:image/svg+xml,%3Csvg fill='%23fff'");\n`);
    const findings = scanFile(f);
    expect(findings).toHaveLength(0);
  });

  it('returns no findings for a clean file', () => {
    const f = writeTmp('i.scss', [
      `.component {`,
      `  color: var(--text-primary);`,
      `  background: var(--bg-secondary);`,
      `  border: 1px solid var(--border-color);`,
      `}`,
    ].join('\n'));
    const findings = scanFile(f);
    expect(findings).toHaveLength(0);
  });
});

describe('scanFile — finding metadata', () => {
  it('reports the correct line number for a multi-line file', () => {
    const f = writeTmp('j.scss', [
      `.clean { color: var(--text-primary); }`,
      `.dirty { color: #ff0000; }`,
      `.alsoClean { color: var(--error-color); }`,
    ].join('\n'));
    const findings = scanFile(f);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it('reports the correct column for the match', () => {
    const f = writeTmp('k.scss', `.x { color: #abcdef; }\n`);
    const findings = scanFile(f);
    // Column of '#' in '.x { color: #abcdef; }' — starts at index 12, col = 13
    expect(findings[0].col).toBe(13);
  });

  it('reports the file path on every finding', () => {
    const f = writeTmp('l.scss', `color: #aabbcc;\n`);
    const findings = scanFile(f);
    expect(findings[0].file).toBe(f);
  });
});
