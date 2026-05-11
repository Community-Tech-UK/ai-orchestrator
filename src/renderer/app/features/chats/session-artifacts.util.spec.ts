import { describe, expect, it } from 'vitest';
import {
  applyStatusFilter,
  buildArtifactEntries,
  COLLAPSED_STORAGE_PREFIX,
  defaultOpenStrategy,
  formatChipTooltip,
  formatMarkdownLink,
  summarizeArtifacts,
  type ArtifactEntry,
} from './session-artifacts.util';
import type { Instance } from '../../core/state/instance/instance.types';

type DiffStats = NonNullable<Instance['diffStats']>;

function makeDiffStats(
  files: Record<string, { status: 'added' | 'modified' | 'deleted'; added?: number; deleted?: number }>,
): DiffStats {
  const populated: DiffStats['files'] = {};
  let totalAdded = 0;
  let totalDeleted = 0;
  for (const [path, entry] of Object.entries(files)) {
    const added = entry.added ?? 0;
    const deleted = entry.deleted ?? 0;
    populated[path] = { path, status: entry.status, added, deleted };
    totalAdded += added;
    totalDeleted += deleted;
  }
  return { files: populated, totalAdded, totalDeleted };
}

describe('session-artifacts.util', () => {
  describe('buildArtifactEntries', () => {
    it('returns [] when diffStats is null/undefined', () => {
      expect(buildArtifactEntries(null, '/proj')).toEqual([]);
      expect(buildArtifactEntries(undefined, '/proj')).toEqual([]);
    });

    it('returns [] when cwd is null/undefined', () => {
      const stats = makeDiffStats({ 'PLAN.md': { status: 'added' } });
      expect(buildArtifactEntries(stats, null)).toEqual([]);
      expect(buildArtifactEntries(stats, undefined)).toEqual([]);
    });

    it('keeps artifact files (md, docx, pdf, png, csv) and drops code files', () => {
      const stats = makeDiffStats({
        'PLAN.md': { status: 'added', added: 12 },
        'src/foo.ts': { status: 'added', added: 100 },
        'docs/notes.txt': { status: 'modified', added: 3, deleted: 1 },
        'Report.docx': { status: 'added' },
        'image.png': { status: 'added' },
        'data.csv': { status: 'added' },
        'package.json': { status: 'modified' },
      });
      const entries = buildArtifactEntries(stats, '/Users/me/proj');
      const basenames = entries.map((e) => e.basename).sort();
      expect(basenames).toEqual(['PLAN.md', 'Report.docx', 'data.csv', 'image.png', 'notes.txt']);
    });

    it('sorts by status (added → modified → deleted) then by basename', () => {
      const stats = makeDiffStats({
        'zebra.md': { status: 'modified' },
        'aardvark.md': { status: 'modified' },
        'NEW2.md': { status: 'added' },
        'NEW1.md': { status: 'added' },
        'OLD.md': { status: 'deleted' },
      });
      const entries = buildArtifactEntries(stats, '/Users/me/proj');
      expect(entries.map((e) => e.basename)).toEqual([
        'NEW1.md', 'NEW2.md', 'aardvark.md', 'zebra.md', 'OLD.md',
      ]);
    });

    it('resolves absolute paths inside the working directory', () => {
      const stats = makeDiffStats({ 'docs/foo.md': { status: 'added' } });
      const entries = buildArtifactEntries(stats, '/Users/me/proj');
      expect(entries[0].absPath).toBe('/Users/me/proj/docs/foo.md');
      expect(entries[0].outsideCwd).toBe(false);
    });

    it('flags entries whose relPath starts with ".." as outside the cwd', () => {
      const stats = makeDiffStats({
        '../tmp/plan.md': { status: 'added' },
        'inside.md': { status: 'added' },
      });
      const entries = buildArtifactEntries(stats, '/Users/me/proj');
      const byBasename = new Map(entries.map((e) => [e.basename, e]));
      expect(byBasename.get('plan.md')?.outsideCwd).toBe(true);
      expect(byBasename.get('plan.md')?.absPath).toBe('/Users/me/tmp/plan.md');
      expect(byBasename.get('inside.md')?.outsideCwd).toBe(false);
    });

    it('classifies entries into the right artifact category', () => {
      const stats = makeDiffStats({
        'foo.md': { status: 'added' },
        'bar.docx': { status: 'added' },
        'baz.png': { status: 'added' },
        'qux.csv': { status: 'added' },
        'lab.ipynb': { status: 'added' },
      });
      const entries = buildArtifactEntries(stats, '/Users/me/proj');
      const byBasename = new Map(entries.map((e) => [e.basename, e]));
      expect(byBasename.get('foo.md')?.category).toBe('doc');
      expect(byBasename.get('bar.docx')?.category).toBe('office');
      expect(byBasename.get('baz.png')?.category).toBe('image');
      expect(byBasename.get('qux.csv')?.category).toBe('data');
      expect(byBasename.get('lab.ipynb')?.category).toBe('notebook');
    });

    it('preserves line counts on each entry', () => {
      const stats = makeDiffStats({
        'PLAN.md': { status: 'modified', added: 25, deleted: 10 },
      });
      const entries = buildArtifactEntries(stats, '/Users/me/proj');
      expect(entries[0].added).toBe(25);
      expect(entries[0].deleted).toBe(10);
    });
  });

  describe('summarizeArtifacts', () => {
    it('counts entries by status', () => {
      const entries: ArtifactEntry[] = [
        { status: 'added' } as ArtifactEntry,
        { status: 'added' } as ArtifactEntry,
        { status: 'modified' } as ArtifactEntry,
        { status: 'deleted' } as ArtifactEntry,
      ];
      expect(summarizeArtifacts(entries)).toEqual({ added: 2, modified: 1, deleted: 1 });
    });

    it('returns zeros for an empty list', () => {
      expect(summarizeArtifacts([])).toEqual({ added: 0, modified: 0, deleted: 0 });
    });
  });

  describe('applyStatusFilter', () => {
    const entries: ArtifactEntry[] = [
      { status: 'added', basename: 'a.md' } as ArtifactEntry,
      { status: 'modified', basename: 'b.md' } as ArtifactEntry,
      { status: 'deleted', basename: 'c.md' } as ArtifactEntry,
    ];

    it('returns all entries when filter is "all"', () => {
      expect(applyStatusFilter(entries, 'all')).toEqual(entries);
    });

    it('filters to status="added"', () => {
      expect(applyStatusFilter(entries, 'added').map((e) => e.basename)).toEqual(['a.md']);
    });

    it('filters to status="modified"', () => {
      expect(applyStatusFilter(entries, 'modified').map((e) => e.basename)).toEqual(['b.md']);
    });

    it('filters to status="deleted"', () => {
      expect(applyStatusFilter(entries, 'deleted').map((e) => e.basename)).toEqual(['c.md']);
    });
  });

  describe('formatChipTooltip', () => {
    it('includes path, status label, and line counts', () => {
      const entry: ArtifactEntry = {
        relPath: 'docs/PLAN.md',
        status: 'modified',
        added: 12,
        deleted: 3,
        basename: 'PLAN.md',
      } as ArtifactEntry;
      const tip = formatChipTooltip(entry);
      expect(tip).toContain('docs/PLAN.md');
      expect(tip).toContain('Updated');
      expect(tip).toContain('+12');
      expect(tip).toContain('-3');
    });

    it('omits zero line counts', () => {
      const entry: ArtifactEntry = {
        relPath: 'PLAN.md',
        status: 'added',
        added: 0,
        deleted: 0,
      } as ArtifactEntry;
      const tip = formatChipTooltip(entry);
      expect(tip).not.toContain('+0');
      expect(tip).not.toContain('-0');
      expect(tip).toContain('New');
    });

    it('shows "New" for added, "Updated" for modified, "Deleted" for deleted', () => {
      const make = (status: 'added' | 'modified' | 'deleted'): ArtifactEntry =>
        ({ relPath: 'x.md', status, added: 0, deleted: 0 } as ArtifactEntry);
      expect(formatChipTooltip(make('added'))).toContain('New');
      expect(formatChipTooltip(make('modified'))).toContain('Updated');
      expect(formatChipTooltip(make('deleted'))).toContain('Deleted');
    });
  });

  describe('COLLAPSED_STORAGE_PREFIX', () => {
    it('is a stable localStorage key prefix scoped by chat id', () => {
      expect(COLLAPSED_STORAGE_PREFIX).toBe('session-artifacts-strip:collapsed:');
    });
  });

  describe('defaultOpenStrategy', () => {
    it('uses the system default app for office docs', () => {
      expect(defaultOpenStrategy('office')).toBe('default-app');
    });

    it('uses the system default app for images', () => {
      expect(defaultOpenStrategy('image')).toBe('default-app');
    });

    it('uses the configured editor for markdown / text docs', () => {
      expect(defaultOpenStrategy('doc')).toBe('editor');
    });

    it('uses the configured editor for data exports (csv/tsv)', () => {
      expect(defaultOpenStrategy('data')).toBe('editor');
    });

    it('uses the configured editor for notebooks', () => {
      expect(defaultOpenStrategy('notebook')).toBe('editor');
    });
  });

  describe('formatMarkdownLink', () => {
    it('produces a clickable markdown link with the absolute path', () => {
      const entry: ArtifactEntry = {
        basename: 'PLAN.md',
        absPath: '/Users/me/proj/PLAN.md',
      } as ArtifactEntry;
      expect(formatMarkdownLink(entry)).toBe('[PLAN.md](/Users/me/proj/PLAN.md)');
    });
  });
});
