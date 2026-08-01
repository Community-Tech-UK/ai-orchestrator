/**
 * WS-C5 — automation operating-authority contract derivation.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_AUTHORITY_TEMPLATES,
  automationToAuthorityInput,
  deriveAutomationAuthority,
  formToAuthorityInput,
  type AutomationAuthorityCard,
  type AutomationAuthorityInput,
} from './automation-authority';
import { emptyForm, type AutomationFormModel } from './automation-form-model';
import type { Automation } from '../../../../shared/types/automation.types';

const BASE_INPUT: AutomationAuthorityInput = {
  workingDirectory: '/repo/project',
  yoloMode: false,
  concurrencyPolicy: 'skip',
  destinationKind: 'newInstance',
  loop: { enabled: false, verifyCommand: '', isolateWorkspace: true },
};

function cardsByKind(input: AutomationAuthorityInput): Record<string, AutomationAuthorityCard> {
  const map: Record<string, AutomationAuthorityCard> = {};
  for (const card of deriveAutomationAuthority(input).cards) {
    map[card.kind] = card;
  }
  return map;
}

function statementSources(card: AutomationAuthorityCard): string[] {
  return card.statements.map((statement) => statement.source);
}

describe('deriveAutomationAuthority', () => {
  it('always produces all six required cards', () => {
    const cards = deriveAutomationAuthority(BASE_INPUT).cards;
    expect(cards.map((card) => card.kind)).toEqual([
      'mayAccess',
      'mayChange',
      'mustAskBefore',
      'stopsWhen',
      'verification',
      'reportDestination',
    ]);
  });

  it('every statement is honestly classified as technical or instruction-only', () => {
    const cards = deriveAutomationAuthority(BASE_INPUT).cards;
    for (const card of cards) {
      for (const statement of card.statements) {
        expect(['technical', 'instruction-only']).toContain(statement.enforcement);
        expect(statement.statement.length).toBeGreaterThan(0);
      }
    }
  });

  describe('May access', () => {
    it('reports the working directory as a real (technical) fact', () => {
      const card = cardsByKind(BASE_INPUT)['mayAccess'];
      expect(card.statements[0].enforcement).toBe('technical');
      expect(card.statements[0].statement).toContain('/repo/project');
      expect(card.statements[0].source).toBe('action.workingDirectory');
    });

    it('flags a missing working directory instead of pretending one exists', () => {
      const card = cardsByKind({ ...BASE_INPUT, workingDirectory: '' })['mayAccess'];
      expect(card.statements[0].statement).toMatch(/no project folder/i);
    });

    it('adds a pinned-node statement only when forceNodeId is set', () => {
      expect(statementSources(cardsByKind(BASE_INPUT)['mayAccess'])).not.toContain('action.forceNodeId');
      const withNode = cardsByKind({ ...BASE_INPUT, forceNodeId: 'node-7' })['mayAccess'];
      const nodeStatement = withNode.statements.find((s) => s.source === 'action.forceNodeId');
      expect(nodeStatement?.enforcement).toBe('technical');
      expect(nodeStatement?.statement).toContain('node-7');
    });
  });

  describe('May change / Must ask before — yoloMode honesty', () => {
    it('yoloMode false: both cards report the sandbox/approval gate as technical', () => {
      const cards = cardsByKind(BASE_INPUT);
      expect(cards['mayChange'].statements[0].enforcement).toBe('technical');
      expect(cards['mustAskBefore'].statements[0].enforcement).toBe('technical');
      expect(cards['mustAskBefore'].statements).toHaveLength(1);
    });

    it('yoloMode true: grants full write access AND downgrades remaining prompt limits to instruction-only', () => {
      const cards = cardsByKind({ ...BASE_INPUT, yoloMode: true });
      expect(cards['mayChange'].statements[0].enforcement).toBe('technical');
      expect(cards['mayChange'].statements[0].statement).toMatch(/without pausing to ask/);

      const mustAsk = cards['mustAskBefore'].statements;
      expect(mustAsk[0].enforcement).toBe('technical');
      // The "only the prompt asks" caveat must NEVER be presented as enforced.
      const promptCaveat = mustAsk.find((s) => s.source === 'action.prompt');
      expect(promptCaveat?.enforcement).toBe('instruction-only');
    });
  });

  describe('May change — loop isolation', () => {
    it('adds no isolation statement when the loop is disabled', () => {
      expect(statementSources(cardsByKind(BASE_INPUT)['mayChange'])).not.toContain('action.loop.isolateWorkspace');
    });

    it('isolated worktree is reported as technical and distinct from the live checkout', () => {
      const input: AutomationAuthorityInput = {
        ...BASE_INPUT,
        yoloMode: true,
        loop: { enabled: true, verifyCommand: '', isolateWorkspace: true },
      };
      const statement = cardsByKind(input)['mayChange'].statements.find((s) => s.source === 'action.loop.isolateWorkspace');
      expect(statement?.enforcement).toBe('technical');
      expect(statement?.statement).toMatch(/isolated copy/);
    });

    it('a non-isolated loop honestly reports it edits the live checkout directly', () => {
      const input: AutomationAuthorityInput = {
        ...BASE_INPUT,
        yoloMode: true,
        loop: { enabled: true, verifyCommand: '', isolateWorkspace: false },
      };
      const statement = cardsByKind(input)['mayChange'].statements.find((s) => s.source === 'action.loop.isolateWorkspace');
      expect(statement?.statement).toMatch(/live checkout/);
      expect(statement?.statement).not.toMatch(/isolated copy/);
    });
  });

  describe('Stops when', () => {
    it('always includes the auto-disable breaker and the unattended-wait guard', () => {
      const sources = statementSources(cardsByKind(BASE_INPUT)['stopsWhen']);
      expect(sources).toContain('system:consecutive-failure-breaker');
      expect(sources).toContain('system:unattended-wait-guard');
    });

    it('reflects concurrencyPolicy honestly (skip vs queue)', () => {
      const skip = cardsByKind({ ...BASE_INPUT, concurrencyPolicy: 'skip' })['stopsWhen'];
      expect(skip.statements.find((s) => s.source === 'concurrencyPolicy')?.statement).toMatch(/skips/i);

      const queue = cardsByKind({ ...BASE_INPUT, concurrencyPolicy: 'queue' })['stopsWhen'];
      expect(queue.statements.find((s) => s.source === 'concurrencyPolicy')?.statement).toMatch(/queues/i);
    });

    it('reports explicit loop caps when set', () => {
      const input: AutomationAuthorityInput = {
        ...BASE_INPUT,
        loop: { enabled: true, verifyCommand: '', isolateWorkspace: true, maxIterations: 12, maxCostCents: 2500 },
      };
      const card = cardsByKind(input)['stopsWhen'];
      const iterations = card.statements.find((s) => s.source === 'action.loop.maxIterations');
      const cost = card.statements.find((s) => s.source === 'action.loop.maxCostCents');
      expect(iterations?.statement).toContain('12');
      expect(iterations?.enforcement).toBe('technical');
      expect(cost?.statement).toContain('$25.00');
      expect(cost?.enforcement).toBe('technical');
    });

    it('falls back to a default-cap statement when the loop is enabled without explicit caps', () => {
      const input: AutomationAuthorityInput = {
        ...BASE_INPUT,
        loop: { enabled: true, verifyCommand: '', isolateWorkspace: true },
      };
      const card = cardsByKind(input)['stopsWhen'];
      expect(card.statements.some((s) => /default iteration and cost caps/.test(s.statement))).toBe(true);
    });
  });

  describe('Verification', () => {
    it('one-shot (non-loop) automations have no enforced verification — reported honestly as instruction-only', () => {
      const card = cardsByKind(BASE_INPUT)['verification'];
      expect(card.statements[0].enforcement).toBe('instruction-only');
      expect(card.statements[0].source).toBe('action.prompt');
    });

    it('a loop with an explicit verify command reports it as a technical gate', () => {
      const input: AutomationAuthorityInput = {
        ...BASE_INPUT,
        loop: { enabled: true, verifyCommand: 'npm test', isolateWorkspace: true },
      };
      const statement = cardsByKind(input)['verification'].statements[0];
      expect(statement.enforcement).toBe('technical');
      expect(statement.statement).toContain('npm test');
    });

    it('a loop with a blank verify command still reports auto-detected verification as technical (never silently skipped)', () => {
      const input: AutomationAuthorityInput = {
        ...BASE_INPUT,
        loop: { enabled: true, verifyCommand: '', isolateWorkspace: true },
      };
      const statement = cardsByKind(input)['verification'].statements[0];
      expect(statement.enforcement).toBe('technical');
      expect(statement.statement).toMatch(/own verification/);
    });
  });

  describe('Report destination', () => {
    it('newInstance destination', () => {
      const statement = cardsByKind(BASE_INPUT)['reportDestination'].statements[0];
      expect(statement.enforcement).toBe('technical');
      expect(statement.statement).toMatch(/new session/);
    });

    it('thread destination', () => {
      const statement = cardsByKind({ ...BASE_INPUT, destinationKind: 'thread' })['reportDestination'].statements[0];
      expect(statement.statement).toMatch(/existing conversation thread/);
    });
  });
});

describe('formToAuthorityInput', () => {
  it('maps the empty form to a safe, unset baseline', () => {
    const input = formToAuthorityInput(emptyForm());
    expect(input).toEqual({
      workingDirectory: '',
      yoloMode: false,
      forceNodeId: undefined,
      concurrencyPolicy: 'skip',
      destinationKind: 'newInstance',
      loop: { enabled: false, verifyCommand: '', isolateWorkspace: true, maxIterations: undefined, maxCostCents: undefined },
      executionProfile: 'standard',
    });
  });

  it('parses numeric loop caps and ignores garbage/blank values', () => {
    const model: AutomationFormModel = {
      ...emptyForm(),
      loopEnabled: true,
      loopVerifyCommand: '  npm run verify  ',
      loopMaxIterations: '8',
      loopMaxCostCents: 'not-a-number',
      forceNodeId: '  node-3  ',
    };
    const input = formToAuthorityInput(model);
    expect(input.loop.verifyCommand).toBe('npm run verify');
    expect(input.loop.maxIterations).toBe(8);
    expect(input.loop.maxCostCents).toBeUndefined();
    expect(input.forceNodeId).toBe('node-3');
  });

  it('always reports newInstance — the form never edits destination', () => {
    expect(formToAuthorityInput(emptyForm()).destinationKind).toBe('newInstance');
  });
});

describe('automationToAuthorityInput', () => {
  function makeAutomation(overrides: Partial<Automation> = {}): Automation {
    return {
      id: 'a1',
      name: 'Test',
      enabled: true,
      active: true,
      workspaceId: '/repo',
      schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      trigger: { kind: 'schedule' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: { kind: 'newInstance' },
      action: { prompt: 'do things', workingDirectory: '/repo' },
      nextFireAt: null,
      lastFiredAt: null,
      lastRunId: null,
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    };
  }

  it('reads real persisted fields, defaulting loop.isolateWorkspace to true when unset', () => {
    const input = automationToAuthorityInput(makeAutomation());
    expect(input.loop.enabled).toBe(false);
    expect(input.loop.isolateWorkspace).toBe(true);
    expect(input.destinationKind).toBe('newInstance');
  });

  it('reads a thread destination and a configured loop', () => {
    const automation = makeAutomation({
      destination: { kind: 'thread', instanceId: 'inst-1', reviveIfArchived: true },
      action: {
        prompt: 'do things',
        workingDirectory: '/repo',
        yoloMode: true,
        forceNodeId: 'node-9',
        loop: { verifyCommand: 'npm test', isolateWorkspace: false, maxIterations: 5 },
      },
    });
    const input = automationToAuthorityInput(automation);
    expect(input.destinationKind).toBe('thread');
    expect(input.yoloMode).toBe(true);
    expect(input.forceNodeId).toBe('node-9');
    expect(input.loop).toEqual({
      enabled: true,
      verifyCommand: 'npm test',
      isolateWorkspace: false,
      maxIterations: 5,
      maxCostCents: undefined,
    });
  });
});

describe('WS-C7 containment card', () => {
  it('adds no seventh card for a standard (or unset) execution profile', () => {
    expect(deriveAutomationAuthority(BASE_INPUT).cards).toHaveLength(6);
    expect(deriveAutomationAuthority({ ...BASE_INPUT, executionProfile: 'standard' }).cards).toHaveLength(6);
  });

  it('appends an honestly-enforced "what this run can access" card only when contained', () => {
    const cards = deriveAutomationAuthority({ ...BASE_INPUT, executionProfile: 'contained' }).cards;
    expect(cards).toHaveLength(7);
    const containment = cards.find((c) => c.kind === 'containment')!;
    expect(containment.title).toMatch(/what this run can access/i);
    expect(containment.statements.length).toBeGreaterThan(0);
    for (const statement of containment.statements) {
      expect(statement.enforcement).toBe('technical');
    }
    const joined = containment.statements.map((s) => s.statement).join(' ').toLowerCase();
    expect(joined).toMatch(/read-only/);
    expect(joined).toMatch(/no network/);
    expect(joined).toMatch(/api keys/);
    expect(joined).toMatch(/codex/);
  });
});

describe('formToAuthorityInput / automationToAuthorityInput — executionProfile', () => {
  it('formToAuthorityInput reads the form execution profile', () => {
    expect(formToAuthorityInput({ ...emptyForm(), executionProfile: 'contained' }).executionProfile).toBe('contained');
  });

  it('automationToAuthorityInput defaults an absent executionProfile to undefined (treated as standard)', () => {
    const automation: Automation = {
      id: 'a1',
      name: 'Test',
      enabled: true,
      active: true,
      workspaceId: '/repo',
      schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      trigger: { kind: 'schedule' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: { kind: 'newInstance' },
      action: { prompt: 'do things', workingDirectory: '/repo' },
      nextFireAt: null,
      lastFiredAt: null,
      lastRunId: null,
      createdAt: 0,
      updatedAt: 0,
    };
    expect(automationToAuthorityInput(automation).executionProfile).toBeUndefined();
    expect(deriveAutomationAuthority(automationToAuthorityInput(automation)).cards).toHaveLength(6);
  });
});

describe('AUTOMATION_AUTHORITY_TEMPLATES', () => {
  it('defines exactly the three required presets', () => {
    expect(AUTOMATION_AUTHORITY_TEMPLATES.map((t) => t.id)).toEqual([
      'read-only-monitor',
      'prepare-dont-publish',
      'single-repo-implementation',
    ]);
  });

  it('read-only monitor: yolo off, no loop — the contract has no enforced write access', () => {
    const template = AUTOMATION_AUTHORITY_TEMPLATES.find((t) => t.id === 'read-only-monitor')!;
    const patch = template.apply(emptyForm());
    expect(patch.yoloMode).toBe(false);
    expect(patch.loopEnabled).toBe(false);

    const input = formToAuthorityInput({ ...emptyForm(), ...patch });
    const mayChange = deriveAutomationAuthority(input).cards.find((c) => c.kind === 'mayChange')!;
    expect(mayChange.statements[0].statement).toMatch(/safe, read-leaning/);
  });

  it("prepare-don't-publish: yolo on + isolated worktree — never presents publishing as blocked", () => {
    const template = AUTOMATION_AUTHORITY_TEMPLATES.find((t) => t.id === 'prepare-dont-publish')!;
    const patch = template.apply(emptyForm());
    expect(patch.yoloMode).toBe(true);
    expect(patch.loopEnabled).toBe(true);
    expect(patch.loopIsolateWorkspace).toBe(true);

    const input = formToAuthorityInput({ ...emptyForm(), ...patch });
    const contract = deriveAutomationAuthority(input);
    const mayChange = contract.cards.find((c) => c.kind === 'mayChange')!;
    expect(mayChange.statements.some((s) => /isolated copy/.test(s.statement))).toBe(true);
    // Honesty check: with yolo on, the only remaining "don't publish" limit is the
    // prompt's wording, marked instruction-only, not presented as a technical lock.
    const mustAsk = contract.cards.find((c) => c.kind === 'mustAskBefore')!;
    const promptCaveat = mustAsk.statements.find((s) => s.source === 'action.prompt');
    expect(promptCaveat?.enforcement).toBe('instruction-only');
  });

  it('implement-in-one-repo: yolo on, no loop — a single bounded turn, not open-ended autonomy', () => {
    const template = AUTOMATION_AUTHORITY_TEMPLATES.find((t) => t.id === 'single-repo-implementation')!;
    const patch = template.apply(emptyForm());
    expect(patch.yoloMode).toBe(true);
    expect(patch.loopEnabled).toBe(false);
  });

  it('every template sets concurrencyPolicy to skip so runs never pile up unattended', () => {
    for (const template of AUTOMATION_AUTHORITY_TEMPLATES) {
      expect(template.apply(emptyForm()).concurrencyPolicy).toBe('skip');
    }
  });

  it('WS-C7: none of the three templates touch executionProfile — all stay standard, never breakage', () => {
    for (const template of AUTOMATION_AUTHORITY_TEMPLATES) {
      const patch = template.apply(emptyForm());
      expect(patch.executionProfile).toBeUndefined();
      const merged = { ...emptyForm(), ...patch };
      expect(merged.executionProfile).toBe('standard');
      expect(deriveAutomationAuthority(formToAuthorityInput(merged)).cards).toHaveLength(6);
    }
  });
});
