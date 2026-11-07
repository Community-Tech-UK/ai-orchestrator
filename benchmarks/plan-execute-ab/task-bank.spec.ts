import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { loadTaskBank, selectArms, selectTasks, validateTaskBank } from './task-bank';
import type { ArmId, TaskBank } from './types';

const bank: TaskBank = {
  version: 1,
  createdAt: '2026-10-14',
  repos: [{ id: 'ai-orchestrator', localPath: '/repos/ai-orchestrator', stack: 'typescript', notes: '' }],
  tasks: [
    {
      id: 'AIO-01',
      repoId: 'ai-orchestrator',
      commitSha: 'a'.repeat(40),
      parentSha: 'b'.repeat(40),
      commitMessage: 'fix: keep queued saves during shutdown',
      size: 'small',
      prompt: 'Keep queued disconnect saves from being lost during shutdown.',
      hiddenTests: ['src/x.spec.ts'],
      hiddenTestCommand: ['npm', 'run', 'test:quiet', '--', 'src/x.spec.ts'],
      damageCommands: [],
      sourceFiles: ['src/x.ts'],
      verification: { failOnParent: true, passOnCommit: true, checkedAt: '', evidenceDir: '' },
    },
  ],
};

describe('task bank', () => {
  it('accepts a well-formed bank and the committed bank file', () => {
    expect(() => validateTaskBank(bank)).not.toThrow();
    const committed = loadTaskBank(join(process.cwd(), 'benchmarks/plan-execute-ab/tasks/task-bank.json'));
    expect(committed.tasks.length).toBeGreaterThanOrEqual(10);
    for (const task of committed.tasks) {
      expect(task.verification.failOnParent).toBe(true);
      expect(task.verification.passOnCommit).toBe(true);
    }
  });

  it('rejects banks with missing tests, duplicate ids or leaked shas', () => {
    const noTests: TaskBank = { ...bank, tasks: [{ ...bank.tasks[0], hiddenTests: [] }] };
    expect(() => validateTaskBank(noTests)).toThrow(/no hidden tests/);
    const dupe: TaskBank = { ...bank, tasks: [bank.tasks[0], bank.tasks[0]] };
    expect(() => validateTaskBank(dupe)).toThrow(/duplicate/);
    const leaky: TaskBank = {
      ...bank,
      tasks: [{ ...bank.tasks[0], prompt: `See commit ${bank.tasks[0].commitSha}` }],
    };
    expect(() => validateTaskBank(leaky)).toThrow(/leaks a commit sha/);
  });

  it('selects tasks and arms by id and fails on unknown ids', () => {
    expect(selectTasks(bank, ['AIO-01'])).toHaveLength(1);
    expect(() => selectTasks(bank, ['NOPE'])).toThrow(/unknown task ids/);
    expect(selectArms(['A', 'B', 'C1'] as ArmId[], ['a', 'c1'])).toEqual(['A', 'C1']);
    expect(() => selectArms(['A'] as ArmId[], ['Z'])).toThrow(/unknown arm ids/);
  });
});
