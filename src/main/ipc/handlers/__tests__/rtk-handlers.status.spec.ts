/**
 * Plan 18a/18b: the RTK status handler returns the real "Where it applies"
 * rows and the real trial counts, not just "some array". The trial counts are
 * read from real-shaped cost-attribution, hook-decision and Claude transcript
 * files in a temp directory. Suffix R6N6.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcResponse } from '../../validated-handler';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const electronMocks = vi.hoisted(() => ({ handlers: new Map<string, IpcHandler>() }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
}));

const runtimeState = vi.hoisted(() => ({ version: '0.51.0' as string | null }));
vi.mock('../../../cli/rtk/rtk-runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../cli/rtk/rtk-runtime')>(),
  getRtkRuntime: () => ({
    isAvailable: () => true,
    binarySource: () => 'bundled',
    version: () => runtimeState.version,
  }),
}));

vi.mock('../../../cli/rtk/rtk-tracking-reader', () => ({
  RtkTrackingReader: class {},
  getRtkTrackingReader: () => ({
    getDbPath: () => '/tmp/tracking.db',
    isAvailable: () => true,
    getSummary: vi.fn(),
    getRecentHistory: vi.fn(),
  }),
}));

const settingsValues = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: (key: string) => settingsValues.get(key) }),
}));

const costFile = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('../../../core/system/cost-attribution', () => ({
  getCostAttributionFilePath: () => costFile.path,
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerRtkHandlers } from '../rtk-handlers';
import { _resetRtkRolloutForTesting } from '../../../cli/rtk/rtk-rollout';

interface StatusData {
  coverage: { surface: string; mode: string; note: string }[];
  trial: { startedAt: string | null; sessionsWithHook: number; sessionsWithout: number } | null;
}

const roots: string[] = [];
const originalConfigDir = process.env['CLAUDE_CONFIG_DIR'];

async function status(): Promise<StatusData> {
  const handler = electronMocks.handlers.get('rtk:get-status');
  if (!handler) throw new Error('rtk:get-status was not registered');
  const result = await handler({});
  if (!result.success) throw new Error(`status failed: ${JSON.stringify(result.error)}`);
  return result.data as StatusData;
}

function setSettings(enabled: boolean, scope: string): void {
  settingsValues.set('rtkEnabled', enabled);
  settingsValues.set('rtkBundledOnly', false);
  settingsValues.set('rtkAutoApproveScope', scope);
}

/** Real layout: <userData>/cost-attribution, <userData>/rtk/hook-decisions, <claude>/projects/<cwd>. */
async function trialFixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'rtk-handlers-status-'));
  roots.push(root);
  const userData = join(root, 'userData');
  const costDir = join(userData, 'cost-attribution');
  const hookDir = join(userData, 'rtk', 'hook-decisions');
  const project = join(root, 'claude', 'projects', '-work-repo');
  await Promise.all([costDir, hookDir, project].map(dir => mkdir(dir, { recursive: true })));
  process.env['CLAUDE_CONFIG_DIR'] = join(root, 'claude');
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  costFile.path = join(costDir, `cost-attribution-${day}.jsonl`);
  const row = (sessionId: string, arm: 'on' | 'off') => JSON.stringify({
    ts: now, source: 'instance-turn', provider: 'claude', sessionId,
    instanceId: `key-${sessionId}`, rtkArm: arm, rtkTrialEligible: true,
    rtkTrialKey: `key-${sessionId}`, rtkTrialSurface: 'interactive',
  });
  await writeFile(costFile.path, [row('with-hook', 'on'), row('without-hook', 'off')].join('\n'));
  await writeFile(join(hookDir, `${day}.jsonl`), JSON.stringify({
    ts: new Date(now).toISOString(), session_id: 'with-hook', tool_use_id: 'tool-1',
    mode: 'rewrite-only', decision: 'rewritten',
  }));
  const bash = (id: string) => JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command: 'git status' } }] },
  });
  await writeFile(join(project, 'with-hook.jsonl'), bash('tool-1'));
  await writeFile(join(project, 'without-hook.jsonl'), bash('tool-2'));
}

describe('rtk:get-status coverage and trial (R6N6)', () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    _resetRtkRolloutForTesting();
    runtimeState.version = '0.51.0';
    costFile.path = null;
    registerRtkHandlers();
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = originalConfigDir;
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it('with the scope off, reports the real rows: approval hook, nothing for auto-approve or loops', async () => {
    setSettings(true, 'off');
    const { coverage, trial } = await status();
    expect(coverage.map(({ surface, mode }) => [surface, mode])).toEqual([
      ['Claude asking for approval', 'Hook'],
      ['Claude auto-approve', 'Off'],
      ['Loops', 'Off'],
      ['Codex', 'Instructions only'],
      ['Copilot, Cursor, OpenCode, Grok', 'Instructions only'],
      ['Antigravity and Gemini', 'Instructions only'],
      ['Remote machines', 'Off'],
    ]);
    expect(coverage[0]).toEqual({
      surface: 'Claude asking for approval',
      mode: 'Hook',
      note: 'The approval hook also shortens command output.',
    });
    expect(trial).toBeNull();
  });

  it('with RTK switched off, the first row reports Off and says why', async () => {
    setSettings(false, 'off');
    const { coverage } = await status();
    expect(coverage[0]).toEqual({
      surface: 'Claude asking for approval',
      mode: 'Off',
      note: 'No hook: no usable RTK (Rust Token Killer) copy or the feature is off.',
    });
    expect(coverage.slice(1, 3).map(row => row.mode)).toEqual(['Off', 'Off']);
    expect(coverage.slice(3, 6).map(row => row.mode)).toEqual(['Off', 'Off', 'Off']);
  });

  it('passes the stored scope through, so a trial scope shows Trial on sessions and loops', async () => {
    setSettings(true, 'trial');
    const { coverage } = await status();
    expect(coverage[1]).toMatchObject({ surface: 'Claude auto-approve', mode: 'Trial' });
    expect(coverage[2]).toMatchObject({ surface: 'Loops', mode: 'Trial' });
  });

  it('returns the real trial counts read from the ledger, hook log and transcripts', async () => {
    setSettings(true, 'trial');
    await trialFixture();
    const { trial } = await status();
    expect(trial).toEqual({
      startedAt: new Date().toISOString().slice(0, 10),
      sessionsWithHook: 1,
      sessionsWithout: 1,
    });
  });

  it('reports no trial block when the scope is not trial, even with trial-shaped data on disk', async () => {
    setSettings(true, 'off');
    await trialFixture();
    expect((await status()).trial).toBeNull();
  });
});
