import { describe, expect, it } from 'vitest';
import {
  RecentDirsGetPayloadSchema,
  RecentDirsAddPayloadSchema,
  RecentDirsRemovePayloadSchema,
  RecentDirsPinPayloadSchema,
  RecentDirsReorderPayloadSchema,
  RecentDirsClearPayloadSchema,
  LspPositionPayloadSchema,
  LspFindReferencesPayloadSchema,
  LspFilePayloadSchema,
  LspWorkspaceSymbolPayloadSchema,
  CodebaseSearchPayloadSchema,
  CodebaseSearchSymbolsPayloadSchema,
  VcsIsRepoPayloadSchema,
  VcsGetStatusPayloadSchema,
  VcsGetBranchesPayloadSchema,
  VcsGetCommitsPayloadSchema,
  VcsGetDiffPayloadSchema,
  VcsGetFileHistoryPayloadSchema,
  VcsGetFileAtCommitPayloadSchema,
  VcsGetBlamePayloadSchema,
  VcsStageFilesPayloadSchema,
  VcsUnstageFilesPayloadSchema,
  VcsDiscardFilesPayloadSchema,
  VcsCommitPayloadSchema,
  VcsFetchPayloadSchema,
  VcsPullPayloadSchema,
  VcsPushPayloadSchema,
  VcsCheckoutBranchPayloadSchema,
  VcsOperationCancelPayloadSchema,
} from '../workspace-tools.schemas';

describe('workspace-tools.schemas', () => {
  it('LspPositionPayloadSchema requires filePath and position', () => {
    expect(() => LspPositionPayloadSchema.parse({})).toThrow();
  });

  it('exports all workspace-tools-group schemas as Zod schemas', () => {
    const schemas = [
      RecentDirsGetPayloadSchema, RecentDirsAddPayloadSchema,
      RecentDirsRemovePayloadSchema, RecentDirsPinPayloadSchema,
      RecentDirsReorderPayloadSchema, RecentDirsClearPayloadSchema,
      LspPositionPayloadSchema, LspFindReferencesPayloadSchema,
      LspFilePayloadSchema, LspWorkspaceSymbolPayloadSchema,
      CodebaseSearchPayloadSchema, CodebaseSearchSymbolsPayloadSchema,
      VcsIsRepoPayloadSchema, VcsGetStatusPayloadSchema,
      VcsGetBranchesPayloadSchema, VcsGetCommitsPayloadSchema,
      VcsGetDiffPayloadSchema, VcsGetFileHistoryPayloadSchema,
      VcsGetFileAtCommitPayloadSchema, VcsGetBlamePayloadSchema,
      VcsStageFilesPayloadSchema, VcsUnstageFilesPayloadSchema,
      VcsDiscardFilesPayloadSchema, VcsCommitPayloadSchema,
      VcsFetchPayloadSchema, VcsPullPayloadSchema, VcsPushPayloadSchema,
      VcsCheckoutBranchPayloadSchema, VcsOperationCancelPayloadSchema,
    ];
    for (const schema of schemas) {
      expect(typeof schema.parse).toBe('function');
    }
  });

  // -------------------------------------------------------------------
  // Stage / unstage (Phase 2d — item 7)
  // -------------------------------------------------------------------
  describe('VcsStageFilesPayloadSchema', () => {
    it('accepts a valid stage payload', () => {
      const parsed = VcsStageFilesPayloadSchema.parse({
        workingDirectory: '/work/project',
        filePaths: ['src/a.ts', 'src/b.ts'],
      });
      expect(parsed.filePaths).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('rejects an empty filePaths array (must stage at least one file)', () => {
      expect(() =>
        VcsStageFilesPayloadSchema.parse({
          workingDirectory: '/work/project',
          filePaths: [],
        })
      ).toThrow();
    });

    it('rejects a payload missing workingDirectory', () => {
      expect(() =>
        VcsStageFilesPayloadSchema.parse({
          filePaths: ['src/a.ts'],
        })
      ).toThrow();
    });

    it('rejects empty-string entries in filePaths', () => {
      expect(() =>
        VcsStageFilesPayloadSchema.parse({
          workingDirectory: '/work/project',
          filePaths: [''],
        })
      ).toThrow();
    });
  });

  describe('VcsUnstageFilesPayloadSchema', () => {
    it('accepts a valid unstage payload', () => {
      const parsed = VcsUnstageFilesPayloadSchema.parse({
        workingDirectory: '/work/project',
        filePaths: ['src/a.ts'],
      });
      expect(parsed.workingDirectory).toBe('/work/project');
    });

    it('rejects an empty filePaths array', () => {
      expect(() =>
        VcsUnstageFilesPayloadSchema.parse({
          workingDirectory: '/work/project',
          filePaths: [],
        })
      ).toThrow();
    });
  });

  // -------------------------------------------------------------------
  // Discard / commit / fetch / pull / push / checkout (Phase 2d items 8–11)
  // -------------------------------------------------------------------

  describe('VcsDiscardFilesPayloadSchema', () => {
    it('accepts a valid discard payload', () => {
      const parsed = VcsDiscardFilesPayloadSchema.parse({
        workingDirectory: '/work/project',
        filePaths: ['a.txt', 'untracked-dir/'],
      });
      expect(parsed.filePaths).toHaveLength(2);
    });

    it('rejects an empty filePaths array', () => {
      expect(() =>
        VcsDiscardFilesPayloadSchema.parse({
          workingDirectory: '/work',
          filePaths: [],
        })
      ).toThrow();
    });
  });

  describe('VcsCommitPayloadSchema', () => {
    it('accepts a minimal commit payload', () => {
      const parsed = VcsCommitPayloadSchema.parse({
        workingDirectory: '/work',
        message: 'feat: add thing',
      });
      expect(parsed.message).toBe('feat: add thing');
      expect(parsed.signoff).toBeUndefined();
    });

    it('accepts signoff + amend flags', () => {
      const parsed = VcsCommitPayloadSchema.parse({
        workingDirectory: '/work',
        message: 'fix: refine',
        signoff: true,
        amend: true,
      });
      expect(parsed.signoff).toBe(true);
      expect(parsed.amend).toBe(true);
    });

    it('rejects an empty commit message', () => {
      expect(() =>
        VcsCommitPayloadSchema.parse({
          workingDirectory: '/work',
          message: '',
        })
      ).toThrow();
    });
  });

  describe('VcsFetchPayloadSchema', () => {
    it('accepts minimal fetch payload (opId only)', () => {
      const parsed = VcsFetchPayloadSchema.parse({
        workingDirectory: '/work',
        opId: 'op-1',
      });
      expect(parsed.opId).toBe('op-1');
    });

    it('rejects a missing opId', () => {
      expect(() =>
        VcsFetchPayloadSchema.parse({ workingDirectory: '/work' })
      ).toThrow();
    });
  });

  describe('VcsPullPayloadSchema', () => {
    it('accepts minimal pull payload', () => {
      const parsed = VcsPullPayloadSchema.parse({
        workingDirectory: '/work',
        opId: 'op-1',
      });
      expect(parsed.opId).toBe('op-1');
    });
  });

  describe('VcsPushPayloadSchema', () => {
    it('accepts a push payload with remote + branch + flags', () => {
      const parsed = VcsPushPayloadSchema.parse({
        workingDirectory: '/work',
        remote: 'origin',
        branch: 'feature/x',
        forceWithLease: true,
        setUpstream: true,
        opId: 'op-1',
      });
      expect(parsed.forceWithLease).toBe(true);
      expect(parsed.setUpstream).toBe(true);
    });

    it('rejects payload missing opId', () => {
      expect(() =>
        VcsPushPayloadSchema.parse({ workingDirectory: '/work' })
      ).toThrow();
    });
  });

  describe('VcsCheckoutBranchPayloadSchema', () => {
    it('accepts a valid checkout payload', () => {
      const parsed = VcsCheckoutBranchPayloadSchema.parse({
        workingDirectory: '/work',
        branchName: 'main',
      });
      expect(parsed.branchName).toBe('main');
    });

    it('rejects payload missing branchName', () => {
      expect(() =>
        VcsCheckoutBranchPayloadSchema.parse({ workingDirectory: '/work' })
      ).toThrow();
    });
  });

  describe('VcsOperationCancelPayloadSchema', () => {
    it('accepts a valid cancel payload', () => {
      expect(VcsOperationCancelPayloadSchema.parse({ opId: 'op-1' }).opId).toBe('op-1');
    });
    it('rejects an empty opId', () => {
      expect(() => VcsOperationCancelPayloadSchema.parse({ opId: '' })).toThrow();
    });
  });
});
