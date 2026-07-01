import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDiffTracker } from './session-diff-tracker';

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory and return its path. */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sdt-test-'));
}

/** Write text to a file, creating parent dirs as needed. */
function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/** Remove a directory recursively. */
function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionDiffTracker', () => {
  let tmpDir: string;
  let tracker: SessionDiffTracker;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    tracker = new SessionDiffTracker(tmpDir);
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  // =========================================================================
  // captureBaseline
  // =========================================================================

  describe('captureBaseline', () => {
    it('captures the content of an existing file', () => {
      const filePath = path.join(tmpDir, 'hello.txt');
      writeFile(filePath, 'line1\nline2\n');

      tracker.captureBaseline(filePath);

      // Mutate the file, then compute diff — should see the change.
      writeFile(filePath, 'line1\nline2\nline3\n');
      const stats = tracker.computeDiff();

      expect(stats.totalAdded).toBe(1);
      expect(stats.totalDeleted).toBe(0);
    });

    it('does NOT re-capture the same file within the same turn', () => {
      const filePath = path.join(tmpDir, 'once.txt');
      writeFile(filePath, 'original\n');

      // First capture — baseline = "original\n"
      tracker.captureBaseline(filePath);

      // Now change the file on disk and call captureBaseline again.
      writeFile(filePath, 'changed-before-second-capture\n');
      tracker.captureBaseline(filePath); // should be ignored

      // Current content is 'changed-before-second-capture\n'
      const stats = tracker.computeDiff();

      // Baseline was "original\n", current is "changed-before-second-capture\n"
      // → 1 deleted, 1 added (diffLines replaces the line)
      expect(stats.totalAdded).toBe(1);
      expect(stats.totalDeleted).toBe(1);
    });

    it('uses empty string as baseline for non-existent files', () => {
      const filePath = path.join(tmpDir, 'new-file.txt');
      // File does not exist yet.
      tracker.captureBaseline(filePath);

      // Now create the file.
      writeFile(filePath, 'new content\n');
      const stats = tracker.computeDiff();

      // Baseline was empty, current has 1 line → 1 added, 0 deleted.
      expect(stats.totalAdded).toBe(1);
      expect(stats.totalDeleted).toBe(0);
      expect(stats.files[path.relative(tmpDir, filePath)].status).toBe('added');
    });
  });

  // =========================================================================
  // computeDiff
  // =========================================================================

  describe('computeDiff', () => {
    it('computes additions and deletions across multiple files', () => {
      const fileA = path.join(tmpDir, 'a.txt');
      const fileB = path.join(tmpDir, 'b.txt');

      writeFile(fileA, 'line1\nline2\n');
      writeFile(fileB, 'alpha\nbeta\ngamma\n');

      tracker.captureBaseline(fileA);
      tracker.captureBaseline(fileB);

      // Modify both files.
      writeFile(fileA, 'line1\nline2\nline3\n'); // +1 line
      writeFile(fileB, 'alpha\n');               // -2 lines

      const stats = tracker.computeDiff();

      expect(stats.totalAdded).toBe(1);
      expect(stats.totalDeleted).toBe(2);
      expect(Object.keys(stats.files)).toHaveLength(2);
    });

    it('detects deleted files (file content becomes empty)', () => {
      const filePath = path.join(tmpDir, 'will-be-emptied.txt');
      writeFile(filePath, 'some content\nmore content\n');

      tracker.captureBaseline(filePath);

      // Simulate deletion by truncating to empty.
      writeFile(filePath, '');
      const stats = tracker.computeDiff();

      expect(stats.totalDeleted).toBe(2);
      expect(stats.totalAdded).toBe(0);
      expect(stats.files[path.relative(tmpDir, filePath)].status).toBe('deleted');
    });

    it('returns zero stats when files are unchanged', () => {
      const filePath = path.join(tmpDir, 'unchanged.txt');
      writeFile(filePath, 'same content\n');

      tracker.captureBaseline(filePath);
      // No modification.
      const stats = tracker.computeDiff();

      expect(stats.totalAdded).toBe(0);
      expect(stats.totalDeleted).toBe(0);
      expect(Object.keys(stats.files)).toHaveLength(0);
    });

    it('reports the NET change across multiple computeDiff calls (no double-count)', () => {
      const filePath = path.join(tmpDir, 'multi-turn.txt');
      writeFile(filePath, 'line1\n');

      // Turn 1 — session baseline is captured as "line1\n".
      tracker.captureBaseline(filePath);
      writeFile(filePath, 'line1\nline2\n');
      const statsAfterTurn1 = tracker.computeDiff();

      expect(statsAfterTurn1.totalAdded).toBe(1);

      // Turn 2 — the file is touched again, but its session baseline stays
      // "line1\n" (later captures are ignored). The diff is net vs the original,
      // NOT cumulative churn against the previous turn.
      tracker.captureBaseline(filePath);
      writeFile(filePath, 'line1\nline2\nline3\n');
      const statsAfterTurn2 = tracker.computeDiff();

      // Net vs "line1\n" is +2, not 1 (turn1) + 1 (turn2) tallied separately.
      expect(statsAfterTurn2.totalAdded).toBe(2);
      expect(statsAfterTurn2.totalDeleted).toBe(0);
    });

    it('nets out changes that are later reverted', () => {
      const filePath = path.join(tmpDir, 'reverted.txt');
      writeFile(filePath, 'line1\n');

      // Session baseline = "line1\n".
      tracker.captureBaseline(filePath);

      // Turn 1: add a line.
      writeFile(filePath, 'line1\nline2\n');
      expect(tracker.computeDiff().totalAdded).toBe(1);

      // Turn 2: revert the file back to its baseline. The old cumulative tracker
      // would still report +1 forever; net semantics drop it to zero.
      writeFile(filePath, 'line1\n');
      const stats = tracker.computeDiff();

      expect(stats.totalAdded).toBe(0);
      expect(stats.totalDeleted).toBe(0);
      expect(Object.keys(stats.files)).toHaveLength(0);
    });

    it('re-diffs against the session baseline on every call (baselines persist)', () => {
      const filePath = path.join(tmpDir, 'persistent.txt');
      writeFile(filePath, 'original\n');

      tracker.captureBaseline(filePath);
      writeFile(filePath, 'modified\n');
      tracker.computeDiff(); // baseline retained for the session

      // A later turn changes the file again WITHOUT a new captureBaseline.
      // The diff is still measured against the original "original\n".
      writeFile(filePath, 'modified-again\n');
      const stats = tracker.computeDiff();

      // "original\n" → "modified-again\n" is one line replaced: +1 / -1.
      expect(stats.totalAdded).toBe(1);
      expect(stats.totalDeleted).toBe(1);
    });
  });

  // =========================================================================
  // Binary file handling
  // =========================================================================

  describe('binary file handling', () => {
    it('counts a binary file as 1 file change with 0 line changes', () => {
      const filePath = path.join(tmpDir, 'image.bin');
      // Write a buffer containing a null byte to trigger binary detection.
      const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
      fs.writeFileSync(filePath, binaryData);

      tracker.captureBaseline(filePath);
      // Overwrite with different binary data.
      fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02]));

      const stats = tracker.computeDiff();

      expect(stats.totalAdded).toBe(0);
      expect(stats.totalDeleted).toBe(0);
      const relPath = path.relative(tmpDir, filePath);
      expect(stats.files[relPath]).toBeDefined();
      expect(stats.files[relPath].added).toBe(0);
      expect(stats.files[relPath].deleted).toBe(0);
    });

    it('does NOT surface a binary file that was unchanged between baseline and diff', () => {
      // Regression: previously a binary baseline always emitted a
      // 'modified' entry on computeDiff regardless of whether the file
      // actually changed (because the null-marker baseline short-circuited
      // the comparison). With size+mtime baselines, unchanged binaries are
      // correctly skipped — important now that the Bash tool-output parser
      // also captures binary references like `cat foo.pdf | head`.
      const filePath = path.join(tmpDir, 'unchanged.bin');
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a]));

      tracker.captureBaseline(filePath);
      // No modification.
      const stats = tracker.computeDiff();

      expect(Object.keys(stats.files)).toHaveLength(0);
    });

    it('reports a binary file created from scratch as added', () => {
      // Mirrors the real-world scenario behind this fix: the agent runs
      // `python3 -c "doc.save('proposal.docx')"`. captureBaseline fires
      // before the script runs (file absent), then computeDiff fires after
      // the script writes the binary docx.
      const filePath = path.join(tmpDir, 'proposal.docx');
      // File doesn't exist yet.
      tracker.captureBaseline(filePath);

      // Now simulate the script writing a binary docx (PK zip header + null).
      fs.writeFileSync(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

      const stats = tracker.computeDiff();

      const relPath = path.relative(tmpDir, filePath);
      expect(stats.files[relPath]).toBeDefined();
      expect(stats.files[relPath].status).toBe('added');
      expect(stats.files[relPath].added).toBe(0);
      expect(stats.files[relPath].deleted).toBe(0);
    });

    it('reports a binary file deleted between baseline and diff as deleted', () => {
      const filePath = path.join(tmpDir, 'will-vanish.bin');
      fs.writeFileSync(filePath, Buffer.from([0x00, 0xff, 0xaa]));

      tracker.captureBaseline(filePath);
      fs.unlinkSync(filePath);

      const stats = tracker.computeDiff();

      const relPath = path.relative(tmpDir, filePath);
      expect(stats.files[relPath]).toBeDefined();
      expect(stats.files[relPath].status).toBe('deleted');
    });
  });

  // =========================================================================
  // Path handling
  // =========================================================================

  describe('path handling', () => {
    it('resolves relative paths against the working directory', () => {
      const filePath = path.join(tmpDir, 'relative.txt');
      writeFile(filePath, 'hello\n');

      // Pass relative path.
      tracker.captureBaseline('relative.txt');
      writeFile(filePath, 'hello\nworld\n');

      const stats = tracker.computeDiff();

      expect(stats.totalAdded).toBe(1);
      // The key in files should be the relative path.
      expect(stats.files['relative.txt']).toBeDefined();
    });

    it('ignores non-artifact files outside the working directory', () => {
      const outsideDir = makeTmpDir();
      try {
        const outsideFile = path.join(outsideDir, 'outside.js');
        writeFile(outsideFile, 'console.log(1)\n');

        tracker.captureBaseline(outsideFile);
        writeFile(outsideFile, 'console.log(1)\nconsole.log(2)\n');

        const stats = tracker.computeDiff();

        expect(stats.totalAdded).toBe(0);
        expect(Object.keys(stats.files)).toHaveLength(0);
      } finally {
        rmDir(outsideDir);
      }
    });

    it('tracks artifact files outside the working directory', () => {
      // Artifact-type files (e.g. .md, .pdf, generated images) are sometimes
      // dropped in /tmp by agents — surface them so the user can find them.
      const outsideDir = makeTmpDir();
      try {
        const outsideArtifact = path.join(outsideDir, 'plan.md');
        writeFile(outsideArtifact, '# Initial\n');

        tracker.captureBaseline(outsideArtifact);
        writeFile(outsideArtifact, '# Initial\n## Step 1\n');

        const stats = tracker.computeDiff();

        expect(stats.totalAdded).toBeGreaterThan(0);
        // The map key is a relative path, which for an outside-cwd file will
        // start with `..` — the renderer resolves it back to absolute via cwd.
        const keys = Object.keys(stats.files);
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/plan\.md$/);
      } finally {
        rmDir(outsideDir);
      }
    });

    it('returns file paths as relative to the working directory in stats', () => {
      const subDir = path.join(tmpDir, 'src', 'lib');
      const filePath = path.join(subDir, 'utils.ts');
      writeFile(filePath, 'export function foo() {}\n');

      tracker.captureBaseline(filePath);
      writeFile(filePath, 'export function foo() {}\nexport function bar() {}\n');

      const stats = tracker.computeDiff();

      const expectedKey = path.join('src', 'lib', 'utils.ts');
      expect(stats.files[expectedKey]).toBeDefined();
    });
  });

  // =========================================================================
  // reset()
  // =========================================================================

  describe('reset', () => {
    it('clears all accumulated stats and baselines', () => {
      const filePath = path.join(tmpDir, 'file.txt');
      writeFile(filePath, 'line1\n');

      tracker.captureBaseline(filePath);
      writeFile(filePath, 'line1\nline2\n');
      tracker.computeDiff();

      tracker.reset();

      const stats = tracker.getStats();
      expect(stats.totalAdded).toBe(0);
      expect(stats.totalDeleted).toBe(0);
      expect(Object.keys(stats.files)).toHaveLength(0);
    });
  });
});
