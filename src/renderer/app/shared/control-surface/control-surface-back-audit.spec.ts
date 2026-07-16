import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appDirectory = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const featuresDirectory = join(appDirectory, 'features');

const DISALLOWED_PATTERNS: readonly RegExp[] = [
  /aria-label="Back to dashboard"/i,
  /(?:←|&larr;)\s*Back/,
  /Back to (?:Dashboard|Projects)/,
  /backRoute="\//,
  /class="[^"]*(?:back-btn|back-button|fleet-back|cp-back|stats-back)[^"]*"/,
  /\.(?:back-btn|back-button|fleet-back|cp-back|stats-back)\b/,
  /\bgoBack\(\): void/,
  /\bnavigateBack\(\): void/,
];

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }
    if (!/\.(?:ts|html|scss|css)$/.test(entry.name) || entry.name.endsWith('.spec.ts')) {
      return [];
    }
    return [path];
  });
}

function isExcluded(path: string): boolean {
  // Normalize to forward slashes so the exclusion list matches on Windows,
  // where relative() emits backslash separators.
  const rel = relative(featuresDirectory, path).split(sep).join('/');
  return rel.startsWith('setup/')
    || rel.startsWith('coming-soon/')
    || rel === 'settings/settings.component.ts';
}

describe('Control Surface Back ownership', () => {
  it('does not leave primary Back controls inside migrated feature sources', () => {
    const offenders = listSourceFiles(featuresDirectory)
      .filter((path) => !isExcluded(path))
      .flatMap((path) => {
        const rel = relative(appDirectory, path);
        return readFileSync(path, 'utf8')
          .split('\n')
          .flatMap((line, index) =>
            DISALLOWED_PATTERNS.some((pattern) => pattern.test(line))
              ? [`${rel}:${index + 1}: ${line.trim()}`]
              : [],
          );
      });

    expect(offenders).toEqual([]);
  });
});
