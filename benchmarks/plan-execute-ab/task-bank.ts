import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { ArmId, TaskBank, TaskDefinition } from './types';

export function loadTaskBank(path: string): TaskBank {
  const raw = readFileSync(resolve(path), 'utf8');
  const bank = JSON.parse(raw) as TaskBank;
  validateTaskBank(bank);
  return bank;
}

export function validateTaskBank(bank: TaskBank): void {
  if (!Array.isArray(bank.tasks) || bank.tasks.length === 0) {
    throw new Error('task bank: no tasks');
  }
  const seen = new Set<string>();
  const repoIds = new Set((bank.repos ?? []).map((r) => r.id));
  for (const task of bank.tasks) {
    if (seen.has(task.id)) throw new Error(`task bank: duplicate task id ${task.id}`);
    seen.add(task.id);
    if (!repoIds.has(task.repoId)) throw new Error(`task ${task.id}: unknown repo ${task.repoId}`);
    if (!task.commitSha || !task.parentSha) throw new Error(`task ${task.id}: missing shas`);
    if (task.commitSha === task.parentSha) throw new Error(`task ${task.id}: parent equals commit`);
    if (!task.prompt.trim()) throw new Error(`task ${task.id}: empty prompt`);
    if (task.hiddenTests.length === 0) throw new Error(`task ${task.id}: no hidden tests`);
    if (task.hiddenTestCommand.length === 0) throw new Error(`task ${task.id}: no hidden test command`);
    if (task.hiddenTestAmendment && (!task.hiddenTestAmendment.version.trim()
      || !task.hiddenTestAmendment.patchFile.trim() || !/^[a-f0-9]{64}$/.test(task.hiddenTestAmendment.sha256))) {
      throw new Error(`task ${task.id}: invalid scoring amendment provenance`);
    }
    for (const line of task.prompt.split('\n')) {
      if (line.includes(task.commitSha) || line.includes(task.parentSha)) {
        throw new Error(`task ${task.id}: prompt leaks a commit sha`);
      }
    }
    if (task.prompt.includes(task.commitMessage.trim()) && task.commitMessage.trim().length > 40) {
      throw new Error(`task ${task.id}: prompt quotes the commit message verbatim`);
    }
  }
}

export function selectTasks(bank: TaskBank, ids: string[] | undefined): TaskDefinition[] {
  if (!ids || ids.length === 0) return bank.tasks;
  const wanted = new Set(ids);
  const tasks = bank.tasks.filter((t) => wanted.has(t.id));
  const missing = [...wanted].filter((id) => !tasks.some((t) => t.id === id));
  if (missing.length > 0) throw new Error(`unknown task ids: ${missing.join(', ')}`);
  return tasks;
}

export function selectArms(all: ArmId[], requested: string[] | undefined): ArmId[] {
  if (!requested || requested.length === 0) return all;
  const wanted = new Set(requested.map((a) => a.toUpperCase()));
  const arms = all.filter((a) => wanted.has(a));
  const missing = [...wanted].filter((a) => !arms.some((x) => x === a));
  if (missing.length > 0) throw new Error(`unknown arm ids: ${missing.join(', ')}`);
  return arms;
}
