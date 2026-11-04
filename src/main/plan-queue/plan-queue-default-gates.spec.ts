import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { defaultRunConfigFor } from './plan-queue-default-gates';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plan-queue-gates-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const allScripts = Object.fromEntries(
  [...DEFAULT_PLAN_QUEUE_CONFIG.plans.verifierGates, ...DEFAULT_PLAN_QUEUE_CONFIG.plans.postMergeGate]
    .flatMap((command) => /^npm run (\S+)/.exec(command)?.[1] ?? []).map((name) => [name, 'true']),
);

describe('defaultRunConfigFor', () => {
  it('keeps this repository\'s checklists for a project that defines every script and has a tsconfig', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: allScripts }));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    expect(await defaultRunConfigFor(root, 'plans')).toEqual(DEFAULT_PLAN_QUEUE_CONFIG.plans);
    expect(await defaultRunConfigFor(root, 'livetests')).toEqual(DEFAULT_PLAN_QUEUE_CONFIG.livetests);
  });

  it('starts a project with no package.json with no checklist, so the verifier uses its documented checks', async () => {
    const config = await defaultRunConfigFor(root, 'plans');
    expect(config).toEqual({ ...DEFAULT_PLAN_QUEUE_CONFIG.plans, verifierGates: [], postMergeGate: [] });
  });

  it('does the same when one script is missing, or there is no tsconfig for the type-check', async () => {
    const { lint: _lint, ...withoutLint } = allScripts;
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: withoutLint }));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    expect((await defaultRunConfigFor(root, 'plans')).verifierGates).toEqual([]);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: allScripts }));
    rmSync(join(root, 'tsconfig.json'));
    expect((await defaultRunConfigFor(root, 'plans')).verifierGates).toEqual([]);
  });

  it('keeps every other default (slots, rounds, load limit) for a project without the scripts', async () => {
    const config = await defaultRunConfigFor(root, 'livetests');
    expect(config).toMatchObject({ workerSlots: 1, verificationSlots: 1, maxRounds: 3, maxLoadAverage: 30 });
  });
});
