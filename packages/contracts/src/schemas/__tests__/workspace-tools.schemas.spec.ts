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
    ];
    for (const schema of schemas) {
      expect(typeof schema.parse).toBe('function');
    }
  });
});
