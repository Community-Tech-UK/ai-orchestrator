/**
 * Plan Step 2: the Claude helper-agent trial reads only the session-policy log,
 * so every Claude spawn path that starts a process must write one record of
 * what was actually placed on that process. These tests drive the REAL adapter
 * (real env pack, real argv builder, real `claudePolicyExposure`); only the
 * child process and the log writer are faked. Removing the
 * `recordSessionPolicy(claudePolicyExposure(...))` call from any one path
 * (`sendMessage`, `sendMessageStream`, `spawn`) fails that path's tests.
 */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
// No transcript lookups against the real ~/.claude folder.
vi.mock('./claude-transcript-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-transcript-registry')>()),
  nativeTranscriptExists: () => false,
  nativeSessionIdInUse: () => false,
  readLastClaudeCostState: () => undefined,
}));

const recordMock = vi.hoisted(() => vi.fn());
vi.mock('../../core/system/session-policy-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/system/session-policy-log')>()),
  recordSessionPolicy: recordMock,
}));

// The CLI version is not probed in a unit test; 2.1.300 is past both the
// CLAUDE_CODE_SUBAGENT_MODEL gate (2.1.251) and the subagent-prompt-file gate (2.1.261).
vi.mock('./claude-cli-feature-probes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-cli-feature-probes')>()),
  resolveClaudeCliVersion: () => '2.1.300',
}));

// The waiting rule is shipped off; switch it on here so the "delivered" side
// of `waitingRuleDelivered` is observable. The rule file is never written.
vi.mock('./claude-subagent-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-subagent-policy')>()),
  CLAUDE_SUBAGENT_WAITING_RULE_ROLLOUT: true,
  materializeSubagentWaitingRuleFile: () => '/placeholder/waiting-rule.txt',
}));

import { ClaudeCliAdapter } from './claude-cli-adapter';
import { _setSettingsReaderForTesting } from './claude-env-pack';
import { CLAUDE_HELPER_REVIEWER_RULE } from './claude-subagent-policy';
import type { ClaudeSessionPolicyRecord } from '../../core/system/session-policy-log';

// Last hex digit 0-7 puts a session in the Sonnet arm of the trial; 8-f in same-as-session.
const SONNET_ARM_SESSION = 'f47ac10b-58cc-4372-a567-0e02b2c3d470';
const SAME_ARM_SESSION = 'f47ac10b-58cc-4372-a567-0e02b2c3d4a9';

function child(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), exitCode: null }) as unknown as ChildProcess;
}

interface Scenario {
  name: string;
  sessionId: string;
  systemPrompt?: string;
  expected: Omit<ClaudeSessionPolicyRecord, 'sessionId'>;
}

const scenarios: Scenario[] = [
  {
    name: 'trial Sonnet arm with both rules delivered',
    sessionId: SONNET_ARM_SESSION,
    systemPrompt: `Orchestrator brief.\n${CLAUDE_HELPER_REVIEWER_RULE}`,
    expected: {
      provider: 'claude', setting: 'trial', arm: 'sonnet', applied: true,
      armKey: 'item-1', armSource: 'plan-queue-item',
      reviewerRuleDelivered: true, waitingRuleDelivered: true,
    },
  },
  {
    name: 'trial same-as-session arm without the reviewer rule',
    sessionId: SAME_ARM_SESSION,
    systemPrompt: 'Orchestrator brief with no helper rules.',
    expected: {
      provider: 'claude', setting: 'trial', arm: 'same-as-session', applied: false,
      armKey: 'item-1', armSource: 'plan-queue-item',
      reviewerRuleDelivered: false, waitingRuleDelivered: true,
    },
  },
];

type Path = 'sendMessage' | 'sendMessageStream' | 'spawn';

/** Start one process through the named spawn path and return its child plus a cleanup. */
async function startPath(path: Path, adapter: ClaudeCliAdapter, spawn: ReturnType<typeof vi.fn>, proc: ChildProcess) {
  spawn.mockReturnValue(proc);
  if (path === 'spawn') {
    await adapter.spawn();
    return async () => { proc.emit('exit', 0, null); proc.emit('close', 0); };
  }
  if (path === 'sendMessage') {
    const response = adapter.sendMessage({ role: 'user', content: 'hello' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    return async () => {
      proc.stdout?.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', result: 'done' })}\n`));
      proc.emit('close', 0);
      await response;
    };
  }
  const stream = adapter.sendMessageStream({ role: 'user', content: 'hello' });
  const drained = (async () => { for await (const _chunk of stream) { /* drain */ } })();
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  return async () => { (proc.stdout as PassThrough).end(); await drained; };
}

describe('ClaudeCliAdapter session-policy exposure record (plan Step 2)', () => {
  let inheritedSubagentModel: string | undefined;
  beforeEach(() => {
    recordMock.mockReset();
    inheritedSubagentModel = process.env['CLAUDE_CODE_SUBAGENT_MODEL'];
    delete process.env['CLAUDE_CODE_SUBAGENT_MODEL'];
    delete process.env['CLAUDE_CODE_SUBAGENT_MODEL_FORCE'];
    // Only the helper-agent setting is 'trial'; every other setting reads as unset.
    _setSettingsReaderForTesting((key) => (key === 'claudeHelperAgentModel' ? 'trial' : undefined));
  });
  afterEach(() => {
    _setSettingsReaderForTesting(null);
    if (inheritedSubagentModel === undefined) delete process.env['CLAUDE_CODE_SUBAGENT_MODEL'];
    else process.env['CLAUDE_CODE_SUBAGENT_MODEL'] = inheritedSubagentModel;
    vi.restoreAllMocks();
  });

  describe.each<Path>(['sendMessage', 'sendMessageStream', 'spawn'])('%s', (path) => {
    it.each(scenarios)('records one claude record for the $name', async ({ sessionId, systemPrompt, expected }) => {
      const adapter = new ClaudeCliAdapter({
        sessionId, systemPrompt, model: 'claude-opus-4-6', yoloMode: true,
        workingDirectory: '/tmp/aio-policy-exposure-test',
        trialKey: 'item-1', trialKeySource: 'plan-queue-item',
      });
      const spawn = vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess');
      const finish = await startPath(path, adapter, spawn as unknown as ReturnType<typeof vi.fn>, child(20001));

      expect(recordMock).toHaveBeenCalledTimes(1);
      expect(recordMock.mock.calls[0][0]).toEqual({ ...expected, sessionId } satisfies ClaudeSessionPolicyRecord);

      await finish();
    });
  });
});
