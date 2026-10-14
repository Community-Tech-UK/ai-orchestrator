import { describe, expect, it } from 'vitest';
import { WorktreeLeftoversListPayloadSchema, WorktreeLeftoversPreviewPayloadSchema,
  WorktreeLeftoversRemovePayloadSchema } from '../workspace-tools.schemas';
describe('leftover folder requests', () => {
  const input = { repoRoot: '/repo', path: '/repo/.worktrees/old', action: 'remove-folder' };
  it('accepts one explicit action and requires the preview ticket', () => {
    expect(WorktreeLeftoversListPayloadSchema.parse({})).toEqual({});
    expect(WorktreeLeftoversPreviewPayloadSchema.parse(input)).toEqual(input);
    expect(WorktreeLeftoversRemovePayloadSchema.safeParse(input).success).toBe(false);
    expect(WorktreeLeftoversRemovePayloadSchema.parse({ ...input, previewId: 'preview' }).previewId).toBe('preview');
  });
  it('rejects bulk and unknown actions and invalid discard confirmation', () => {
    expect(WorktreeLeftoversPreviewPayloadSchema.safeParse({ ...input, paths: ['/other'] }).success).toBe(false);
    expect(WorktreeLeftoversPreviewPayloadSchema.safeParse({ ...input, action: 'remove-all' }).success).toBe(false);
    expect(WorktreeLeftoversRemovePayloadSchema.safeParse({ ...input, previewId: 'preview', discardSavedWork: 'yes' }).success).toBe(false);
  });
});
