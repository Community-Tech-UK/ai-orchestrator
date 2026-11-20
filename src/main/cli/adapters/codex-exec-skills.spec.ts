import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexCliConfig } from './codex-adapter-config';
import * as costAttribution from '../../core/system/cost-attribution';
import { _resetRequiredSkillsForTesting } from './codex/codex-required-skills';
import { readSessionPolicyEvents, type SessionRequiredSkillsRecord } from '../../core/system/session-policy-log';

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => settings.value }),
}));

import { CodexCliAdapter } from './codex-cli-adapter';

vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

const children: ChildProcess[] = [];
const directories: string[] = [];
beforeEach(() => {
  settings.value = { codexContextTuning: 'harness', codexHelperAgentsHarnessWork: 'full' };
  _resetRequiredSkillsForTesting();
});
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A throwaway working directory holding the two installed skills the turns name. */
function workingDirWithSkills(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aio-exec-skills-'));
  directories.push(directory);
  for (const name of ['lt-probe-skill', 'task-completion-gate']) {
    mkdirSync(join(directory, '.agents', 'skills', name), { recursive: true });
    writeFileSync(join(directory, '.agents', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  return directory;
}

interface ExecLaunch { argv: string[]; stdin: string }

/** Runs each message as one synthetic native exec turn and records its argv and the exact process input. */
async function runExecTurns(config: CodexCliConfig, messages: string[]): Promise<ExecLaunch[]> {
  const workingDir = config.workingDir ?? workingDirWithSkills();
  vi.spyOn(costAttribution, 'getCostAttributionDirectory').mockReturnValue(workingDir);
  const adapter = new CodexCliAdapter({ ...config, workingDir });
  Object.assign(adapter, { useAppServer: false, isSpawned: true });
  const launches: ExecLaunch[] = [];
  vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess').mockImplementation((args: string[]) => {
    const inputFile = join(workingDir, `stdin-${launches.length}.txt`);
    launches.push({ argv: args, stdin: '' });
    const child = spawn(process.execPath, ['-e', `
      const chunks = [];
      process.stdin.on('data', chunk => chunks.push(chunk));
      process.stdin.on('end', () => {
        require('node:fs').writeFileSync(${JSON.stringify(inputFile)}, Buffer.concat(chunks));
        for (const event of [
          { type: 'thread.started', thread_id: 'fixture-thread' },
          { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'fixture answer' } },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } },
        ]) process.stdout.write(JSON.stringify(event) + '\\n');
      });
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    return child;
  });
  adapter.on('error', () => {});
  for (const [index, message] of messages.entries()) {
    await (adapter as unknown as { execSendMessage(message: string): Promise<void> }).execSendMessage(message);
    launches[index].stdin = readFileSync(join(workingDir, `stdin-${index}.txt`), 'utf8');
  }
  return launches;
}

const OVERRIDE_OMIT = ['-c', 'skills.include_instructions=false'];
const OVERRIDE_CAP = ['-c', 'skills.max_context_tokens=1500'];
const NAMED_TASK = 'Run the check with the `lt-probe-skill` skill and report the marker.';

describe('Codex exec fallback applies the machine skills policy', () => {
  it('omits the checker catalog and names the named plus the required completion-gate skill', async () => {
    settings.value = { ...settings.value, codexCheckerSkillCatalog: 'omit' };
    const [launch] = await runExecTurns({ sessionKind: 'plan-queue', queueRole: 'verifier', timeout: 5000 }, [NAMED_TASK]);
    expect(launch.argv).toEqual(expect.arrayContaining([...OVERRIDE_CAP, ...OVERRIDE_OMIT]));
    expect(launch.argv.indexOf('exec')).toBeGreaterThan(launch.argv.indexOf('skills.include_instructions=false'));
    expect(launch.stdin).toBe(`${NAMED_TASK}\n\nSkills for this turn: $lt-probe-skill $task-completion-gate`);
  });

  it('keeps the capped full catalog for a checker told to use the full catalog, and names only the skill the task names', async () => {
    settings.value = { ...settings.value, codexCheckerSkillCatalog: 'full' };
    const [launch] = await runExecTurns({ sessionKind: 'plan-queue', queueRole: 'verifier', timeout: 5000 }, [NAMED_TASK]);
    expect(launch.argv).toEqual(expect.arrayContaining(OVERRIDE_CAP));
    expect(launch.argv).not.toContain('skills.include_instructions=false');
    expect(launch.stdin).toBe(`${NAMED_TASK}\n\nSkills for this turn: $lt-probe-skill`);
  });

  it('leaves an ordinary chat on Codex\'s own catalog and its prompt untouched', async () => {
    settings.value = { ...settings.value, codexCheckerSkillCatalog: 'omit' };
    const [launch] = await runExecTurns({ sessionKind: 'chat', queueRole: 'verifier', timeout: 5000 }, [NAMED_TASK]);
    expect(launch.argv.join(' ')).not.toContain('skills.');
    expect(launch.stdin).toBe(NAMED_TASK);
  });

  it('applies the same overrides and skill naming on a resumed turn carrying a Harness reminder', async () => {
    settings.value = { ...settings.value, codexCheckerSkillCatalog: 'omit' };
    const reminder = '<harness_internal_message source="plan-queue">\nReminder: finish the check with the `lt-probe-skill` skill.\n</harness_internal_message>';
    const [, resume] = await runExecTurns({ sessionKind: 'plan-queue', queueRole: 'verifier', timeout: 5000 }, [NAMED_TASK, reminder]);
    expect(resume.argv.slice(0, -1)).toEqual(expect.arrayContaining(['exec', 'resume', ...OVERRIDE_CAP, ...OVERRIDE_OMIT]));
    expect(resume.argv.at(-1)).toBe('fixture-thread');
    expect(resume.stdin).toBe(`${reminder}\n\nSkills for this turn: $lt-probe-skill $task-completion-gate`);
  });

  it('does not name a skill that is not installed', async () => {
    const [launch] = await runExecTurns({ sessionKind: 'loop', timeout: 5000 }, ['Use the `not-installed-skill` skill.']);
    expect(launch.stdin).toBe('Use the `not-installed-skill` skill.');
  });
});

describe('Codex exec checker turns leave a record of the skills they named', () => {
  it('records the names for a checker turn and writes nothing for a worker', async () => {
    const logDirectory = mkdtempSync(join(tmpdir(), 'aio-exec-skill-policy-log-'));
    directories.push(logDirectory);
    process.env['AIO_SESSION_POLICY_DIR'] = logDirectory;
    try {
      settings.value = { ...settings.value, codexCheckerSkillCatalog: 'omit' };
      await runExecTurns({ sessionKind: 'plan-queue', queueRole: 'verifier', harnessInstanceId: 'verifier-1', timeout: 5000 }, [NAMED_TASK]);
      await runExecTurns({ sessionKind: 'plan-queue', queueRole: 'worker', timeout: 5000 }, [NAMED_TASK]);
      expect(readSessionPolicyEvents<SessionRequiredSkillsRecord>('required-skills', 0, logDirectory)).toEqual([expect.objectContaining({
        instanceId: 'verifier-1', threadId: 'fixture-thread', skills: ['lt-probe-skill', 'task-completion-gate'], via: 'mention', catalogOmitted: true, governingSkillNamed: true,
      })]);
    } finally { delete process.env['AIO_SESSION_POLICY_DIR']; }
  });

  it('records nothing for a resumed turn whose input Codex never accepted', async () => {
    const logDirectory = mkdtempSync(join(tmpdir(), 'aio-exec-skill-policy-log-'));
    directories.push(logDirectory);
    process.env['AIO_SESSION_POLICY_DIR'] = logDirectory;
    try {
      settings.value = { ...settings.value, codexCheckerSkillCatalog: 'omit' };
      const workingDir = workingDirWithSkills();
      vi.spyOn(costAttribution, 'getCostAttributionDirectory').mockReturnValue(workingDir);
      const adapter = new CodexCliAdapter({ sessionKind: 'plan-queue', queueRole: 'verifier', harnessInstanceId: 'verifier-1', timeout: 5000, workingDir });
      Object.assign(adapter, { useAppServer: false, isSpawned: true });
      let launches = 0;
      vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess').mockImplementation(() => {
        launches += 1;
        // The first turn completes. Later children have no stdin, so the write is refused before Codex accepts anything.
        const child = launches === 1
          ? spawn(process.execPath, ['-e', `
              process.stdin.resume();
              process.stdin.on('end', () => {
                for (const event of [
                  { type: 'thread.started', thread_id: 'fixture-thread' },
                  { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'fixture answer' } },
                  { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } },
                ]) process.stdout.write(JSON.stringify(event) + '\\n');
              });
            `], { stdio: ['pipe', 'pipe', 'pipe'] })
          : spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        return child;
      });
      adapter.on('error', () => {});
      const send = (message: string) => (adapter as unknown as { execSendMessage(message: string): Promise<void> }).execSendMessage(message);
      await send(NAMED_TASK);
      await send('Reminder: finish the check with the `lt-probe-skill` skill.').catch(() => undefined);
      expect(launches).toBeGreaterThan(1);
      expect(readSessionPolicyEvents<SessionRequiredSkillsRecord>('required-skills', 0, logDirectory)).toHaveLength(1);
    } finally { delete process.env['AIO_SESSION_POLICY_DIR']; }
  });
});
