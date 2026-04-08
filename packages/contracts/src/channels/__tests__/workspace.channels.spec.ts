import { WORKSPACE_CHANNELS } from '../workspace.channels';

describe('WORKSPACE_CHANNELS', () => {
  it('has VCS channels', () => {
    expect(WORKSPACE_CHANNELS.VCS_IS_REPO).toBe('vcs:is-repo');
    expect(WORKSPACE_CHANNELS.VCS_GET_DIFF).toBe('vcs:get-diff');
  });

  it('has worktree channels', () => {
    expect(WORKSPACE_CHANNELS.WORKTREE_CREATE).toBe('worktree:create');
    expect(WORKSPACE_CHANNELS.WORKTREE_SESSION_CREATED).toBe('worktree:session-created');
  });

  it('has parallel worktree channels', () => {
    expect(WORKSPACE_CHANNELS.PARALLEL_WORKTREE_START).toBe('parallel-worktree:start');
    expect(WORKSPACE_CHANNELS.PARALLEL_WORKTREE_MERGE).toBe('parallel-worktree:merge');
  });

  it('has TODO channels', () => {
    expect(WORKSPACE_CHANNELS.TODO_GET_LIST).toBe('todo:get-list');
    expect(WORKSPACE_CHANNELS.TODO_LIST_CHANGED).toBe('todo:list-changed');
  });

  it('has LSP channels', () => {
    expect(WORKSPACE_CHANNELS.LSP_GO_TO_DEFINITION).toBe('lsp:go-to-definition');
    expect(WORKSPACE_CHANNELS.LSP_SHUTDOWN).toBe('lsp:shutdown');
  });

  it('has MCP channels', () => {
    expect(WORKSPACE_CHANNELS.MCP_GET_STATE).toBe('mcp:get-state');
    expect(WORKSPACE_CHANNELS.MCP_STATE_CHANGED).toBe('mcp:state-changed');
  });

  it('has codebase indexing channels', () => {
    expect(WORKSPACE_CHANNELS.CODEBASE_INDEX_STORE).toBe('codebase:index:store');
    expect(WORKSPACE_CHANNELS.CODEBASE_SEARCH).toBe('codebase:search');
  });

  it('has repo job channels', () => {
    expect(WORKSPACE_CHANNELS.REPO_JOB_SUBMIT).toBe('repo-job:submit');
    expect(WORKSPACE_CHANNELS.REPO_JOB_GET_STATS).toBe('repo-job:get-stats');
  });

  it('has task management channels', () => {
    expect(WORKSPACE_CHANNELS.TASK_GET_STATUS).toBe('task:get-status');
    expect(WORKSPACE_CHANNELS.TASK_GET_PREFLIGHT).toBe('task:get-preflight');
  });
});
