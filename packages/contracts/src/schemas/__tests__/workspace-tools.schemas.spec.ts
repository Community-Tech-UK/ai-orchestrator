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
});
