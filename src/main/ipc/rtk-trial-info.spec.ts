import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => loggerMock }));

import { _resetRtkTrialInfoForTesting, readRtkTrialInfo } from './rtk-trial-info';

const fixtures: string[] = [];
beforeEach(() => {
  _resetRtkTrialInfoForTesting();
  vi.clearAllMocks();
});
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rtk-trial-info-'));
  fixtures.push(root);
  const costDir = join(root, 'cost-attribution');
  const hookDir = join(root, 'rtk', 'hook-decisions');
  const projectsDir = join(root, 'projects');
  const project = join(projectsDir, 'workspace');
  await Promise.all([mkdir(costDir, { recursive: true }), mkdir(hookDir, { recursive: true }),
    mkdir(project, { recursive: true })]);
  const today = new Date().toISOString().slice(0, 10);
  const file = join(costDir, `cost-attribution-${today}.jsonl`);
  return { file, hookDir, projectsDir, project, today };
}

function cost(sessionId: string, arm: 'on' | 'off', ts: number, overrides: Record<string, unknown> = {}) {
  return { ts, source: 'instance-turn', provider: 'claude', sessionId,
    instanceId: `key-${sessionId}`, rtkArm: arm,
    rtkTrialEligible: true, rtkTrialKey: `key-${sessionId}`,
    rtkTrialSurface: 'interactive', ...overrides };
}

function hook(sessionId: string, toolId: string, ts: number, overrides: Record<string, unknown> = {}) {
  return { ts: new Date(ts).toISOString(), session_id: sessionId, tool_use_id: toolId,
    mode: 'rewrite-only', decision: 'rewritten', ...overrides };
}

async function transcript(project: string, sessionId: string, toolId?: string) {
  await writeFile(join(project, `${sessionId}.jsonl`), JSON.stringify({
    type: 'assistant', message: { content: toolId
      ? [{ type: 'tool_use', name: 'Bash', id: toolId, input: { command: 'echo test' } }]
      : [{ type: 'text', text: 'done' }] },
  }) + '\n');
}

describe('RTK trial status', () => {
  it('does not start a trial from historical noise when there are no current candidates', async () => {
    const f = await fixture();
    const oldFile = join(f.file, '..', 'cost-attribution-2000-01-01.jsonl');
    await writeFile(oldFile, Array.from({ length: 1000 }, (_, index) =>
      JSON.stringify({ sessionId: `historical-${index}`, provider: 'claude', ts: 1 })).join('\n'));
    await writeFile(f.file, JSON.stringify({ sessionId: 'ordinary', ts: Date.now() }));
    expect(await readRtkTrialInfo('trial', f.file, f)).toBeNull();
  });

  it('still checks older exposure for a current candidate before admitting its native session', async () => {
    const f = await fixture();
    const now = Date.now();
    await writeFile(join(f.file, '..', 'cost-attribution-2000-01-01.jsonl'),
      JSON.stringify({ sessionId: 'same-session', provider: 'claude', ts: 1 }));
    await writeFile(f.file, JSON.stringify(cost('same-session', 'off', now)));
    await transcript(f.project, 'same-session', 'bash');
    expect(await readRtkTrialInfo('trial', f.file, f)).toBeNull();
  });
  it('counts native Claude sessions with observed matching on-arm hook delivery', async () => {
    const f = await fixture();
    const now = Date.now();
    const yesterday = now - 86_400_000;
    await writeFile(f.file, [
      cost('native-on', 'on', now), cost('native-on', 'on', now),
      cost('native-off', 'off', yesterday),
      cost('native-loop', 'on', now, { source: 'one-shot', rtkTrialSurface: 'loop',
        taskType: 'loop-orchestration:claude', correlationId: 'key-native-loop::turn-1' }),
    ].map(row => JSON.stringify(row)).join('\n'));
    await writeFile(join(f.hookDir, `${f.today}.jsonl`), [hook('native-on', 'tool-1', now),
      hook('native-loop', 'tool-loop', now)].map(row => JSON.stringify(row)).join('\n'));
    await Promise.all([transcript(f.project, 'native-on', 'tool-1'), transcript(f.project, 'native-off', 'off-tool'),
      transcript(f.project, 'native-loop', 'tool-loop')]);
    expect(await readRtkTrialInfo('trial', f.file, f)).toEqual({
      startedAt: new Date(yesterday).toISOString().slice(0, 10),
      sessionsWithHook: 2, sessionsWithout: 1,
    });
  });

  it('discovers managed Claude profile transcript stores alongside the default root', async () => {
    const f = await fixture();
    const root = join(f.file, '..', '..');
    const now = Date.now();
    const previousConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = join(root, 'no-claude-config');
    try {
      // One session's transcript sits in the default store and one only in
      // <userData>/claude-cli-profiles/<profile>/projects — the managed account
      // profile store the Savings tab's trial counts used to miss.
      const defaultProject = join(root, 'no-claude-config', 'projects', 'workspace');
      const profileProject = join(root, 'claude-cli-profiles', 'profile-a', 'projects', 'workspace');
      await Promise.all([mkdir(defaultProject, { recursive: true }), mkdir(profileProject, { recursive: true })]);
      await writeFile(f.file, [cost('default-off', 'off', now), cost('profile-off', 'off', now)]
        .map(row => JSON.stringify(row)).join('\n'));
      await writeFile(join(f.hookDir, `${f.today}.jsonl`), '');
      await Promise.all([transcript(defaultProject, 'default-off', 'off-tool'),
        transcript(profileProject, 'profile-off', 'off-tool')]);
      // Discovery runs when no explicit projects directory is supplied.
      expect(await readRtkTrialInfo('trial', f.file, { hookDir: f.hookDir })).toEqual({
        startedAt: f.today, sessionsWithHook: 0, sessionsWithout: 2,
      });
    } finally {
      if (previousConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
      else process.env['CLAUDE_CONFIG_DIR'] = previousConfigDir;
    }
  });

  it('ignores mixed providers, historical arms, non-auto-approve rows and instance-id fallbacks', async () => {
    const f = await fixture();
    const now = Date.now();
    await writeFile(f.file, [
      cost('codex', 'on', now, { provider: 'codex' }),
      cost('historical', 'off', now, { rtkTrialEligible: undefined }),
      cost('approval', 'on', now, { rtkTrialSurface: undefined }),
      cost('no-key', 'off', now, { rtkTrialKey: undefined }),
      cost('wrong-source', 'off', now, { source: 'one-shot' }),
      cost('wrong-instance-key', 'off', now, { instanceId: 'another-instance' }),
      cost('wrong-loop-key', 'off', now, { source: 'one-shot', rtkTrialSurface: 'loop',
        taskType: 'loop-orchestration:claude', correlationId: 'different::turn-1' }),
      { ...cost('no-native-id', 'on', now), sessionId: undefined, instanceId: 'instance-only' },
      cost('valid-off', 'off', now),
    ].map(row => JSON.stringify(row)).join('\n'));
    await writeFile(join(f.hookDir, `${f.today}.jsonl`), '');
    await Promise.all(['codex', 'historical', 'approval', 'no-key', 'wrong-source',
      'wrong-instance-key', 'wrong-loop-key', 'valid-off']
      .map(id => transcript(f.project, id, 'off-tool')));
    expect(await readRtkTrialInfo('trial', f.file, f)).toEqual({
      startedAt: f.today, sessionsWithHook: 0, sessionsWithout: 1,
    });
  });

  it('does not start a clock for missing or mismatched hook decisions or conflicted assignments', async () => {
    const f = await fixture();
    const now = Date.now();
    await writeFile(f.file, [
      cost('no-decision', 'on', now), cost('wrong-tool', 'on', now),
      cost('defer-mode', 'on', now),
      cost('off-hooked', 'off', now),
      cost('conflict', 'on', now), cost('conflict', 'off', now),
      cost('old', 'on', 1),
    ].map(row => JSON.stringify(row)).join('\n'));
    await writeFile(join(f.hookDir, `${f.today}.jsonl`), [
      hook('wrong-tool', 'other-tool', now), hook('off-hooked', 'off-tool', now),
      hook('defer-mode', 'tool-1', now, { mode: 'defer' }),
    ].map(row => JSON.stringify(row)).join('\n'));
    await Promise.all(['no-decision', 'wrong-tool', 'defer-mode', 'off-hooked', 'conflict']
      .map(id => transcript(f.project, id, 'tool-1')));
    expect(await readRtkTrialInfo('trial', f.file, f)).toBeNull();
    expect(await readRtkTrialInfo('off', f.file, f)).toBeNull();
    expect(await readRtkTrialInfo('trial', null, f)).toBeNull();
  });

  it('quarantines a native session if any turn loses eligibility, provider, key or arm', async () => {
    const f = await fixture();
    const now = Date.now();
    const rows = [
      cost('ordinary', 'on', now), cost('ordinary', 'on', now, { rtkTrialEligible: undefined }),
      cost('ordinary', 'on', now),
      cost('approval', 'on', now), cost('approval', 'on', now, { rtkTrialEligible: false }),
      cost('provider', 'on', now), cost('provider', 'on', now, { provider: 'codex' }),
      cost('key', 'on', now), cost('key', 'on', now, { rtkTrialKey: 'another-key' }),
      cost('arm', 'on', now), cost('arm', 'off', now),
      cost('valid-off', 'off', now),
    ];
    await writeFile(f.file, rows.map(row => JSON.stringify(row)).join('\n'));
    await writeFile(join(f.hookDir, `${f.today}.jsonl`),
      ['ordinary', 'approval', 'provider', 'key', 'arm'].map(id => JSON.stringify(hook(id, 'bash', now))).join('\n'));
    await Promise.all(['ordinary', 'approval', 'provider', 'key', 'arm', 'valid-off']
      .map(id => transcript(f.project, id, 'bash')));
    expect(await readRtkTrialInfo('trial', f.file, f)).toEqual({
      startedAt: f.today, sessionsWithHook: 0, sessionsWithout: 1,
    });
  });

  it('keeps zero-Bash on and off sessions outside the measured counts and clock', async () => {
    const f = await fixture();
    const now = Date.now();
    const earlier = now - 10 * 86_400_000;
    await writeFile(f.file, [cost('zero-on', 'on', earlier), cost('zero-off', 'off', earlier),
      cost('valid-on', 'on', now), cost('valid-off', 'off', now)]
      .map(row => JSON.stringify(row)).join('\n'));
    await writeFile(join(f.hookDir, `${f.today}.jsonl`), JSON.stringify(hook('valid-on', 'bash', now)));
    await Promise.all([transcript(f.project, 'zero-on'), transcript(f.project, 'zero-off'),
      transcript(f.project, 'valid-on', 'bash'), transcript(f.project, 'valid-off', 'bash')]);
    expect(await readRtkTrialInfo('trial', f.file, f)).toEqual({
      startedAt: f.today, sessionsWithHook: 1, sessionsWithout: 1,
    });
  });
  it('counts off-arm sessions when the hook-decisions directory does not exist (R5M6 W10)', async () => {
    const f = await fixture();
    const now = Date.now();
    await rm(f.hookDir, { recursive: true, force: true });
    await writeFile(f.file, JSON.stringify(cost('off-only', 'off', now)));
    await transcript(f.project, 'off-only', 'bash');
    expect(await readRtkTrialInfo('trial', f.file, f)).toEqual({
      startedAt: f.today, sessionsWithHook: 0, sessionsWithout: 1,
    });
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('still reports no on-arm session when the hook directory is missing (R5M6 W10)', async () => {
    const f = await fixture();
    const now = Date.now();
    await rm(f.hookDir, { recursive: true, force: true });
    await writeFile(f.file, JSON.stringify(cost('on-only', 'on', now)));
    await transcript(f.project, 'on-only', 'bash');
    expect(await readRtkTrialInfo('trial', f.file, f)).toBeNull();
  });

  it('fails safe to null and logs once on a real hook directory read error (R5M6 W10)', async () => {
    const f = await fixture();
    const now = Date.now();
    // A file where the directory should be: readdir fails with ENOTDIR, not ENOENT.
    await rm(f.hookDir, { recursive: true, force: true });
    await writeFile(f.hookDir, 'not a directory');
    await writeFile(f.file, JSON.stringify(cost('off-only', 'off', now)));
    await transcript(f.project, 'off-only', 'bash');
    expect(await readRtkTrialInfo('trial', f.file, f)).toBeNull();
    expect(await readRtkTrialInfo('trial', f.file, f)).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loggerMock.warn.mock.calls[0])).toContain('ENOTDIR');
  });
});
