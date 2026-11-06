import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../logging/logger', () => ({ getLogger: () => loggerMocks }));

type TruncationModule = typeof import('./tool-output-truncation');

/** Fresh module per test: the temp-storage fallback directory is cached at module level. */
async function loadModule(): Promise<TruncationModule> {
  vi.resetModules();
  return import('./tool-output-truncation');
}

// The limits the Harness MCP backstop and boundBrowserText pass in (Step 9b).
const LIMIT = { maxBytes: 12_000, maxLines: 600 } as const;

let base: string;
let spillDir: string;
let savedTmpdir: string | undefined;
let truncation: TruncationModule;

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-tool-output-test-'));
  spillDir = path.join(base, 'tool-output');
  savedTmpdir = process.env['TMPDIR'];
  truncation = await loadModule();
  truncation._setToolOutputDirForTesting(spillDir);
  for (const mock of Object.values(loggerMocks)) mock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  truncation._setToolOutputDirForTesting(null);
  if (savedTmpdir === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = savedTmpdir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe('truncateToolOutput with the 12,000 limit', () => {
  it('returns text at or under the limit untouched and writes no file', () => {
    const text = 'x'.repeat(12_000);
    expect(truncation.truncateToolOutput(text, LIMIT)).toEqual({ content: text, truncated: false });
    expect(fs.existsSync(spillDir)).toBe(false);
  });

  it('truncates one byte over the limit and keeps the preview within it', () => {
    const result = truncation.truncateToolOutput(`${'x'.repeat(5_999)}\n${'y'.repeat(6_001)}`, LIMIT);
    expect(result.truncated).toBe(true);
    const preview = result.content.split('\n\n[Output truncated')[0];
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(12_000);
  });

  it('turns a 40,000-character result into a preview plus the saved-file note', () => {
    const text = Array.from({ length: 4_000 }, (_, i) => `line-${i}`).join('\n');
    const result = truncation.truncateToolOutput(text, LIMIT);
    expect(result.truncated).toBe(true);
    if (!result.truncated) throw new Error('unreachable');
    expect(result.content.length).toBeLessThan(13_000);
    expect(result.content).toContain('line-0');
    expect(result.content).not.toContain('line-3999');
    expect(result.content).toContain(`saved at ${result.outputPath}`);
  });

  it('truncates on line count even when the bytes are small', () => {
    const text = Array.from({ length: 700 }, (_, i) => `l${i}`).join('\n');
    const result = truncation.truncateToolOutput(text, LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('l599');
    expect(result.content).not.toContain('l600\n');
  });
});

describe('spill file and hint wording', () => {
  it('saves the full text under the tool-output folder and names no provider-specific tool', () => {
    const text = 'x'.repeat(60_000);
    const result = truncation.truncateToolOutput(text);
    expect(result.truncated).toBe(true);
    if (!result.truncated) throw new Error('unreachable');
    expect(path.dirname(result.outputPath)).toBe(spillDir);
    expect(fs.readFileSync(result.outputPath, 'utf8')).toBe(text);
    expect(result.content).toContain('[Output truncated. The full output (60000 bytes) is saved at');
    expect(result.content).toContain('Read that file in sections if you need more.]');
    expect(result.content).not.toMatch(/Read tool|offset\/limit/i);
  });

  it('keeps the tail when asked to, and still saves the whole text', () => {
    const text = Array.from({ length: 3_000 }, (_, i) => `row-${i}`).join('\n');
    const result = truncation.truncateToolOutput(text, { maxLines: 100, direction: 'tail' });
    expect(result.truncated).toBe(true);
    if (!result.truncated) throw new Error('unreachable');
    expect(result.content).toContain('row-2999');
    expect(result.content).not.toContain('row-0\n');
    expect(fs.readFileSync(result.outputPath, 'utf8')).toBe(text);
  });

  it.each([0, 0o777])('keeps new spills private and owner-readable with process mask %s', (mask) => {
    const previousMask = process.umask(mask);
    try {
      const text = 'authorized result\n'.repeat(4_000);
      const result = truncation.truncateToolOutput(text, LIMIT);

      expect(result.truncated).toBe(true);
      if (!result.truncated) throw new Error('unreachable');
      expect(fs.readFileSync(result.outputPath, 'utf8')).toBe(text);
      if (process.platform !== 'win32') {
        expect(fs.statSync(spillDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(result.outputPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      process.umask(previousMask);
    }
  });

  it('hardens an existing spill directory without deleting or rewriting saved output', () => {
    fs.mkdirSync(spillDir, { mode: 0o755 });
    fs.chmodSync(spillDir, 0o755);
    const oldPath = path.join(spillDir, 'existing.txt');
    fs.writeFileSync(oldPath, 'existing authorized output');
    fs.utimesSync(oldPath, new Date(0), new Date(0));

    const result = truncation.truncateToolOutput('x'.repeat(60_000));

    expect(result.truncated).toBe(true);
    if (!result.truncated) throw new Error('unreachable');
    expect(fs.readFileSync(oldPath, 'utf8')).toBe('existing authorized output');
    expect(fs.readFileSync(result.outputPath, 'utf8')).toBe('x'.repeat(60_000));
    if (process.platform !== 'win32') {
      expect(fs.statSync(spillDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(result.outputPath).mode & 0o777).toBe(0o600);
    }
  });
});

describe('when the spill folder cannot be written', () => {
  it('makes an existing fallback directory and its new spill private', () => {
    fs.writeFileSync(path.join(base, 'blocker'), 'not a folder');
    truncation._setToolOutputDirForTesting(path.join(base, 'blocker', 'tool-output'));
    const fallbackTmp = path.join(base, 'tmp');
    const fallbackOutput = path.join(fallbackTmp, 'orchestrator-tool-output');
    fs.mkdirSync(fallbackOutput, { recursive: true });
    fs.chmodSync(fallbackOutput, 0o755);
    process.env['TMPDIR'] = fallbackTmp;

    const result = truncation.truncateToolOutput('x'.repeat(60_000));

    expect(result.truncated).toBe(true);
    if (!result.truncated) throw new Error('unreachable');
    expect(path.dirname(result.outputPath)).toBe(fallbackOutput);
    expect(fs.readFileSync(result.outputPath, 'utf8')).toBe('x'.repeat(60_000));
    if (process.platform !== 'win32') {
      expect(fs.statSync(fallbackOutput).mode & 0o777).toBe(0o700);
      expect(fs.statSync(result.outputPath).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses a linked spill directory without changing the linked destination', () => {
    const target = path.join(base, 'unrelated-directory');
    fs.mkdirSync(target, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, spillDir, process.platform === 'win32' ? 'junction' : 'dir');
    const fallbackTmp = path.join(base, 'tmp');
    fs.mkdirSync(fallbackTmp);
    process.env['TMPDIR'] = fallbackTmp;

    const result = truncation.truncateToolOutput('x'.repeat(60_000));

    expect(result.truncated).toBe(true);
    if (!result.truncated) throw new Error('unreachable');
    expect(path.dirname(result.outputPath)).toBe(path.join(fallbackTmp, 'orchestrator-tool-output'));
    expect(fs.readdirSync(target)).toEqual([]);
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it('never overwrites a colliding spill path that points to another file', () => {
    fs.mkdirSync(spillDir);
    const target = path.join(base, 'unrelated-file.txt');
    fs.writeFileSync(target, 'keep this authorized output');
    // 1000 in base36 is rs; 0.25 in base36 is 0.9, giving this deterministic collision.
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const collision = path.join(spillDir, 'rs-9.txt');
    if (process.platform === 'win32') fs.linkSync(target, collision);
    else fs.symlinkSync(target, collision);
    const fallbackTmp = path.join(base, 'tmp');
    fs.mkdirSync(fallbackTmp);
    process.env['TMPDIR'] = fallbackTmp;

    const result = truncation.truncateToolOutput('x'.repeat(60_000));

    expect(fs.readFileSync(target, 'utf8')).toBe('keep this authorized output');
    expect(result.truncated).toBe(true);
    if (!result.truncated) throw new Error('unreachable');
    expect(path.dirname(result.outputPath)).toBe(path.join(fallbackTmp, 'orchestrator-tool-output'));
    expect(fs.readFileSync(result.outputPath, 'utf8')).toBe('x'.repeat(60_000));
  });

  it('falls back to temp storage and still reports the saved path', () => {
    fs.writeFileSync(path.join(base, 'blocker'), 'a file, not a folder');
    truncation._setToolOutputDirForTesting(path.join(base, 'blocker', 'tool-output'));
    const fallbackTmp = path.join(base, 'tmp');
    fs.mkdirSync(fallbackTmp);
    process.env['TMPDIR'] = fallbackTmp;

    const result = truncation.truncateToolOutput('x'.repeat(60_000));

    expect(result.truncated).toBe(true);
    if (!result.truncated) throw new Error('unreachable');
    expect(result.outputPath.startsWith(path.join(fallbackTmp, 'orchestrator-tool-output'))).toBe(true);
    expect(fs.readFileSync(result.outputPath, 'utf8')).toHaveLength(60_000);
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
  });

  it('returns the preview with the could-not-save marker and no path when nothing is writable', () => {
    fs.writeFileSync(path.join(base, 'blocker'), 'a file, not a folder');
    truncation._setToolOutputDirForTesting(path.join(base, 'blocker', 'tool-output'));
    process.env['TMPDIR'] = path.join(base, 'blocker', 'tmp');

    const text = `${'x'.repeat(30_000)}\ntail-marker`;
    const result = truncation.truncateToolOutput(text, LIMIT);

    expect(result.truncated).toBe(false);
    expect('outputPath' in result).toBe(false);
    expect(result.content).toContain('[Output truncated. Could not save full output to disk. Preview shows first portion of');
    expect(result.content).not.toContain('saved at');
    expect(result.content).not.toContain('tail-marker');
    expect(loggerMocks.error).toHaveBeenCalledTimes(1);
  });
});
