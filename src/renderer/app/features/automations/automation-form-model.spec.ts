/**
 * Fable WS5 Task 6 — form → persisted trigger/loop-action mapping.
 */

import { describe, expect, it } from 'vitest';
import { emptyForm, formToLoopAction, formToTrigger } from './automation-form-model';

describe('formToTrigger', () => {
  it('defaults to schedule', () => {
    expect(formToTrigger(emptyForm())).toEqual({ kind: 'schedule' });
  });

  it('maps a webhook trigger with trimmed filters and drops empty filter rows', () => {
    const model = {
      ...emptyForm(),
      triggerKind: 'webhook' as const,
      webhookRouteId: ' route-1 ',
      webhookFilters: [
        { path: ' issue.state ', operator: 'equals' as const, value: 'open' },
        { path: '', operator: 'contains' as const, value: 'ignored' },
      ],
    };
    expect(formToTrigger(model)).toEqual({
      kind: 'webhook',
      routeId: 'route-1',
      filters: [{ path: 'issue.state', operator: 'equals', value: 'open' }],
    });
  });

  it('falls back to schedule when webhook is selected without a route', () => {
    const model = { ...emptyForm(), triggerKind: 'webhook' as const, webhookRouteId: '  ' };
    expect(formToTrigger(model)).toEqual({ kind: 'schedule' });
  });
});

describe('formToLoopAction', () => {
  it('returns undefined when the loop is off or has no verify authority', () => {
    expect(formToLoopAction(emptyForm())).toBeUndefined();
    expect(formToLoopAction({ ...emptyForm(), loopEnabled: true, loopVerifyCommand: '  ' })).toBeUndefined();
  });

  it('maps verify command, isolation, and numeric caps (ignoring blanks/garbage)', () => {
    const model = {
      ...emptyForm(),
      loopEnabled: true,
      loopVerifyCommand: ' npm test ',
      loopIsolateWorkspace: false,
      loopMaxIterations: '12',
      loopMaxCostCents: 'not-a-number',
    };
    expect(formToLoopAction(model)).toEqual({
      verifyCommand: 'npm test',
      isolateWorkspace: false,
      maxIterations: 12,
    });
  });
});
