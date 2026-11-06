/**
 * Fable WS5 Task 6 — form → persisted trigger/loop-action mapping.
 */

import { describe, expect, it } from 'vitest';
import { CLAUDE_MODELS } from '../../../../shared/types/provider.types';
import {
  checkCommandPatch,
  emptyForm,
  formToLoopAction,
  formToTrigger,
  patchAutomationForm,
  showsCheckModelSuggestion,
  type AutomationFormModel,
} from './automation-form-model';

describe('emptyForm', () => {
  it('pins new automations to standard Claude Opus latest', () => {
    expect(emptyForm()).toMatchObject({
      provider: 'claude',
      model: CLAUDE_MODELS.OPUS,
    });
  });
});

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
  it('returns undefined only when the loop is off', () => {
    expect(formToLoopAction(emptyForm())).toBeUndefined();
  });

  it('keeps the loop action when the verify command is blank (auto-detected at dispatch)', () => {
    // A blank command used to make this return undefined, silently downgrading
    // the automation to a one-shot turn with the loop toggle still switched on.
    expect(formToLoopAction({ ...emptyForm(), loopEnabled: true, loopVerifyCommand: '  ' })).toEqual({
      verifyCommand: '',
      isolateWorkspace: true,
    });
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

describe('check jobs suggest a cheaper model (8e)', () => {
  /** What the page does on each keystroke: patch the form, keep the rest. */
  function typeCheck(form: AutomationFormModel, value: string, modelChosenByUser = false): AutomationFormModel {
    return { ...form, ...checkCommandPatch(form, value, modelChosenByUser) };
  }

  it('a new job with a check and no chosen model preselects Sonnet and shows the note', () => {
    const form = typeCheck(emptyForm(), 'test -s /tmp/new-mail.txt');
    expect(form).toMatchObject({ provider: 'claude', model: CLAUDE_MODELS.SONNET, preCheckCommand: 'test -s /tmp/new-mail.txt' });
    expect(showsCheckModelSuggestion(form)).toBe(true);
  });

  it('a new job with no check keeps the Opus default and shows no note', () => {
    expect(showsCheckModelSuggestion(emptyForm())).toBe(false);
    expect(typeCheck(emptyForm(), '   ')).toMatchObject({ provider: 'claude', model: CLAUDE_MODELS.OPUS });
  });

  it('an existing job is untouched when a check is added', () => {
    const existing: AutomationFormModel = { ...emptyForm(), id: 'automation-1' };
    const form = typeCheck(existing, 'test -s /tmp/new-mail.txt');
    expect(form.model).toBe(CLAUDE_MODELS.OPUS);
    expect(form.provider).toBe('claude');
    expect(showsCheckModelSuggestion(form)).toBe(false);
  });

  it('a model the user chose is never replaced', () => {
    const form = typeCheck(emptyForm(), 'check-news', true);
    expect(form.model).toBe(CLAUDE_MODELS.OPUS);
    expect(showsCheckModelSuggestion(form, true)).toBe(false);
  });

  it('a non-Claude choice is left alone', () => {
    const codex: AutomationFormModel = { ...emptyForm(), provider: 'codex', model: 'gpt-5' };
    expect(typeCheck(codex, 'check-news')).toMatchObject({ provider: 'codex', model: 'gpt-5' });
  });

  it('keeps Sonnet while the check text is edited, and reverts to the automatic Opus choice when it is cleared', () => {
    let form = typeCheck(emptyForm(), 'c');
    form = typeCheck(form, 'check-news');
    expect(form.model).toBe(CLAUDE_MODELS.SONNET);

    form = typeCheck(form, '');
    expect(form).toMatchObject({ provider: 'claude', model: CLAUDE_MODELS.OPUS, preCheckCommand: '' });
    expect(showsCheckModelSuggestion(form)).toBe(false);
  });

  it('a whitespace-only check also reverts, and re-adding a check suggests Sonnet again', () => {
    let form = typeCheck(emptyForm(), 'check-news');
    form = typeCheck(form, '  ');
    expect(form.model).toBe(CLAUDE_MODELS.OPUS);
    form = typeCheck(form, 'check-news');
    expect(form.model).toBe(CLAUDE_MODELS.SONNET);
  });

  it('reverts to an unset automatic model rather than forcing Opus', () => {
    let form = typeCheck({ ...emptyForm(), provider: 'auto', model: '' }, 'check-news');
    expect(form).toMatchObject({ provider: 'claude', model: CLAUDE_MODELS.SONNET });
    form = typeCheck(form, '');
    expect(form).toMatchObject({ provider: 'auto', model: '' });
  });

  it('does not revert a model the user chose after the suggestion', () => {
    let form = typeCheck(emptyForm(), 'check-news');
    // The user opens the picker and picks Sonnet themselves; the page flags it as chosen.
    form = typeCheck(form, '', true);
    expect(form.model).toBe(CLAUDE_MODELS.SONNET);
  });

  it('does not revert a Sonnet that was never suggested (already Sonnet before the check)', () => {
    const sonnet: AutomationFormModel = { ...emptyForm(), model: CLAUDE_MODELS.SONNET };
    let form = typeCheck(sonnet, 'check-news');
    form = typeCheck(form, '');
    expect(form.model).toBe(CLAUDE_MODELS.SONNET);
  });

  it('does not revert an existing job on clear', () => {
    const existing: AutomationFormModel = { ...emptyForm(), id: 'automation-1', model: CLAUDE_MODELS.SONNET };
    expect(typeCheck(existing, '').model).toBe(CLAUDE_MODELS.SONNET);
  });

  it('keeps the check suggestion when the name or prompt is edited afterwards', () => {
    const withCheck = typeCheck(emptyForm(), 'test -s /tmp/new-mail.txt');
    const edited = patchAutomationForm(withCheck, { prompt: 'Summarise the new mail' });
    expect(edited).toMatchObject({ provider: 'claude', model: CLAUDE_MODELS.SONNET });
    expect(showsCheckModelSuggestion(edited)).toBe(true);
  });

  it('still picks the default by wording while no check is set', () => {
    expect(patchAutomationForm(emptyForm(), { prompt: 'Monitor the build' })).toMatchObject({ model: CLAUDE_MODELS.SONNET, reasoningEffort: 'low' });
    expect(patchAutomationForm(emptyForm(), { prompt: 'Write the release notes' })).toMatchObject({ model: CLAUDE_MODELS.OPUS });
  });
});
