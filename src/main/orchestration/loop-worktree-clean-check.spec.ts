import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gitExec } from '../workspace/git/git-exec';
import { isWorktreeClean } from './loop-worktree-clean-check';

vi.mock('../workspace/git/git-exec', () => ({ gitExec: vi.fn() }));

describe('isWorktreeClean', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([' M tracked.txt', '?? unsaved.txt', 'A  staged.txt'])('refuses removal for %s', async (status) => {
    vi.mocked(gitExec).mockResolvedValue(status);
    expect(await isWorktreeClean('/fixture')).toBe(false);
  });

  it('permits an inspected clean folder', async () => {
    vi.mocked(gitExec).mockResolvedValue('');
    expect(await isWorktreeClean('/fixture')).toBe(true);
    expect(gitExec).toHaveBeenCalledWith(['status', '--porcelain'], '/fixture');
  });

  it('fails closed when Git cannot inspect the folder', async () => {
    vi.mocked(gitExec).mockRejectedValue(new Error('inspection unavailable'));
    expect(await isWorktreeClean('/fixture')).toBe(false);
  });
});
