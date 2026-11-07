import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureOpenCodeInstructions } from './opencode-instructions';

describe('OpenCode persistent instructions', () => {
  it('writes private, content-addressed instructions and reuses only matching readable files', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-instructions-'));
    try {
      const path = ensureOpenCodeInstructions(root, 'Retain the accepted rules after compaction.');
      expect(readFileSync(path, 'utf8')).toBe('Retain the accepted rules after compaction.');
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(ensureOpenCodeInstructions(root, 'Retain the accepted rules after compaction.')).toBe(path);
      expect(ensureOpenCodeInstructions(root, 'Different rules')).not.toBe(path);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rewrites a damaged file instead of blocking every start with that prompt', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-instructions-'));
    try {
      const path = ensureOpenCodeInstructions(root, 'Retain the accepted rules after compaction.');
      writeFileSync(path, 'damaged');
      expect(ensureOpenCodeInstructions(root, 'Retain the accepted rules after compaction.')).toBe(path);
      expect(readFileSync(path, 'utf8')).toBe('Retain the accepted rules after compaction.');
      expect(readdirSync(dirname(path)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('still refuses to start when the file cannot be repaired', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-instructions-'));
    try {
      const path = ensureOpenCodeInstructions(root, 'Rules');
      rmSync(path); mkdirSync(path);
      expect(() => ensureOpenCodeInstructions(root, 'Rules')).toThrow('instructions');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
