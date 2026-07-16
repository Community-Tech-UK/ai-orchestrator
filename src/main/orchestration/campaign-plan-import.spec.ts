/**
 * WS8 (loop-convergence plan) — pure campaign builder tests.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCampaignFromPlan,
  computePlanSourceDigest,
  INTEGRATION_GATE_NODE_ID,
  type CampaignPlanImportInput,
} from './campaign-plan-import';
import { validateCampaignSpec } from './campaign-coordinator';
import { prepareLoopStartConfig } from './loop-start-config';

const PLAN = [
  '# Multi-workstream plan',
  'implement one workstream per run.',
  '',
  '## WS1 — Parser',
  '- [ ] build the parser',
  '',
  '## WS2 — Coordinator',
  '- [ ] wire the coordinator',
  '',
  '## Workstream 3 — Renderer',
  '- [ ] add the panel',
].join('\n');

function importInput(over: Partial<CampaignPlanImportInput> = {}): CampaignPlanImportInput {
  return {
    workspaceCwd: '/repo',
    planFile: 'docs/plans/big-plan.md',
    planText: PLAN,
    baseLoop: { verifyCommand: 'npm test' },
    now: 1_700_000_000_000,
    ...over,
  };
}

describe('buildCampaignFromPlan — generated contract', () => {
  it('creates one node per workstream in document order plus the integration gate', () => {
    const { spec } = buildCampaignFromPlan(importInput());
    expect(spec.nodes.map((n) => n.id)).toEqual(['ws1', 'ws2', 'ws3', INTEGRATION_GATE_NODE_ID]);
    expect(spec.nodes[0].label).toBe('WS1 — Parser');
  });

  it('chains completed-only edges in sequence and mirrors dependsOn', () => {
    const { spec } = buildCampaignFromPlan(importInput());
    expect(spec.edges).toEqual([
      { from: 'ws1', to: 'ws2', when: { type: 'is', status: 'completed' } },
      { from: 'ws2', to: 'ws3', when: { type: 'is', status: 'completed' } },
      { from: 'ws3', to: INTEGRATION_GATE_NODE_ID, when: { type: 'is', status: 'completed' } },
    ]);
    expect(spec.nodes[1].dependsOn).toEqual(['ws1']);
    expect(spec.nodes[3].dependsOn).toEqual(['ws3']);
  });

  it('sets the sequential pause-on-review policy without isolation', () => {
    const { spec } = buildCampaignFromPlan(importInput());
    expect(spec.policy).toEqual({ onNodeNeedsReview: 'pause-campaign', maxParallel: 1 });
  });

  it('copies the verify authority and WS6 finite caps into every node', () => {
    const { spec, aggregateMaxCostCents } = buildCampaignFromPlan(importInput());
    for (const node of spec.nodes) {
      expect(node.loopConfig.completion?.verifyCommand).toBe('npm test');
      expect(node.loopConfig.maxTurnsPerIteration).toBe(30);
      expect(node.loopConfig.caps?.maxCostCents).toBe(3_000);
    }
    expect(aggregateMaxCostCents).toBe(spec.nodes.length * 3_000);
  });

  it('workstream nodes never rename the plan; prompts scope them to one workstream', () => {
    const { spec } = buildCampaignFromPlan(importInput());
    const ws2 = spec.nodes[1];
    expect(ws2.loopConfig.completion?.requireCompletedFileRename).toBe(false);
    expect(ws2.loopConfig.planFile).toBeUndefined();
    expect(ws2.loopConfig.initialPrompt).toContain('docs/plans/big-plan.md');
    expect(ws2.loopConfig.initialPrompt).toContain('ONLY');
    expect(ws2.loopConfig.initialPrompt).toContain('WS2');
    expect(ws2.loopConfig.initialPrompt).toContain('do not begin the next workstream');
  });

  it('the integration gate is the only rename authority and runs the canonical checklist', () => {
    const { spec } = buildCampaignFromPlan(importInput());
    const gate = spec.nodes.at(-1)!;
    expect(gate.id).toBe(INTEGRATION_GATE_NODE_ID);
    expect(gate.loopConfig.completion?.requireCompletedFileRename).toBe(true);
    expect(gate.loopConfig.planFile).toBe('docs/plans/big-plan.md');
    expect(gate.loopConfig.initialPrompt).toContain('canonical verification checklist');
    expect(gate.loopConfig.initialPrompt).toContain('_livetest.md');
    expect(gate.loopConfig.initialPrompt).toContain('_completed.md');
  });

  it('node ids are stable across rebuilds of the same plan; campaign id embeds the digest', () => {
    const a = buildCampaignFromPlan(importInput());
    const b = buildCampaignFromPlan(importInput());
    expect(a.spec.nodes.map((n) => n.id)).toEqual(b.spec.nodes.map((n) => n.id));
    expect(a.spec.id).toBe(b.spec.id);
    expect(a.spec.id).toContain(a.sourceDigest.slice(0, 8));
  });

  it('records sourceRef and a sha256 source digest that tracks plan content', () => {
    const result = buildCampaignFromPlan(importInput());
    expect(result.spec.sourceRef).toBe('docs/plans/big-plan.md');
    expect(result.spec.sourceDigest).toBe(computePlanSourceDigest(PLAN));
    const changed = buildCampaignFromPlan(importInput({ planText: `${PLAN}\nchanged` }));
    expect(changed.sourceDigest).not.toBe(result.sourceDigest);
  });

  it('the generated spec passes campaign graph validation', () => {
    const { spec } = buildCampaignFromPlan(importInput());
    expect(validateCampaignSpec(spec)).toEqual({ valid: true, errors: [] });
  });

  it('every generated node config passes prepareLoopStartConfig (WS6 policy included)', async () => {
    const { spec } = buildCampaignFromPlan(importInput());
    for (const node of spec.nodes) {
      const prepared = await prepareLoopStartConfig(node.loopConfig);
      expect(prepared.completion?.verifyCommand).toBe('npm test');
    }
  });
});

describe('buildCampaignFromPlan — refusals', () => {
  it('throws without a verify command (nodes would fail the WS6 authority policy)', () => {
    expect(() => buildCampaignFromPlan(importInput({ baseLoop: { verifyCommand: '  ' } })))
      .toThrow(/verify command/i);
  });

  it('throws when the plan has no extractable workstreams', () => {
    expect(() => buildCampaignFromPlan(importInput({ planText: '# Flat plan\n- [ ] a\n- [ ] b\n' })))
      .toThrow(/No workstreams/i);
  });
});
