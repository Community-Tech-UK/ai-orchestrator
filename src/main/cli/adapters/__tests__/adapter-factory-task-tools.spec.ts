import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliAdapter } from '../adapter-factory';
import { ClaudeCliAdapter } from '../claude-cli-adapter';
import {
  _resetTaskToolsScopingForTesting, configureInstanceTaskTools, setInstanceTaskTools,
} from '../../../instance/lifecycle/task-tools-scoping';

const remoteSpawn = vi.hoisted(() => vi.fn());
vi.mock('../remote-cli-adapter', () => ({
  RemoteCliAdapter: class {
    constructor(_connection: unknown, _nodeId: string, _provider: string, options: unknown) {
      remoteSpawn(options);
    }
  },
}));
vi.mock('../../../remote-node/worker-node-connection', () => ({
  getWorkerNodeConnectionServer: () => ({}),
}));

function taskFlag(instanceId?: string, env?: Record<string, string>): string | undefined {
  const adapter = createCliAdapter('claude', { instanceId, workingDirectory: '/tmp', env });
  if (!(adapter instanceof ClaudeCliAdapter)) throw new Error('Expected a local Claude adapter');
  return adapter.getConfig().env?.['CLAUDE_CODE_ENABLE_TODO_TOOLS'];
}

describe('adapter factory task tools', () => {
  beforeEach(() => {
    _resetTaskToolsScopingForTesting();
    remoteSpawn.mockClear();
    vi.stubEnv('CLAUDE_CODE_ENABLE_TODO_TOOLS', undefined);
  });
  afterEach(() => {
    _resetTaskToolsScopingForTesting();
    vi.unstubAllEnvs();
  });

  it('adds the flag at both initial spawn and respawn for an enrolled chat', () => {
    setInstanceTaskTools('chat', true);
    expect(taskFlag('chat')).toBe('1');
    expect(taskFlag('chat')).toBe('1');
  });

  it('preserves the caller-provided value and does not mutate the caller environment', () => {
    setInstanceTaskTools('chat', true);
    const callerEnv = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' };
    expect(taskFlag('chat', callerEnv)).toBe('0');
    expect(callerEnv).toEqual({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' });
    const emptyEnv = {};
    expect(taskFlag('chat', emptyEnv)).toBe('1');
    expect(emptyEnv).toEqual({});
  });

  it.each([
    { parentId: 'parent' },
    { metadata: { planQueueRunId: 'queue', planQueueRole: 'worker' } },
    { metadata: { automationId: 'automation' } },
    { metadata: { repoJobId: 'job-1', spendPurpose: 'repo-job' } },
    { metadata: { pingPongReviewer: true } },
  ])('omits the flag for machine-started sessions %j', (scope) => {
    configureInstanceTaskTools({
      id: 'machine-session', provider: 'claude', parentId: null,
      executionLocation: { type: 'local' }, ...scope,
    }, true);
    expect(taskFlag('machine-session')).toBeUndefined();
  });

  it('omits the flag for a fresh loop child or warm process without a chat identity', () => {
    setInstanceTaskTools('chat', true);
    expect(taskFlag()).toBeUndefined();
    expect(taskFlag('unregistered-child')).toBeUndefined();
  });

  it('never applies the local task flag to remote spawn options even with a stale registered id', () => {
    setInstanceTaskTools('chat', true);
    createCliAdapter('claude', { instanceId: 'chat', workingDirectory: '/tmp' }, { type: 'remote', nodeId: 'worker' });
    expect(remoteSpawn).toHaveBeenCalledOnce();
    const options = remoteSpawn.mock.calls[0][0] as { env?: Record<string, string> };
    expect(options.env?.['CLAUDE_CODE_ENABLE_TODO_TOOLS']).toBeUndefined();
  });
});
