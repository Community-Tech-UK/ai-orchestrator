import { describe, expect, it } from 'vitest';
import {
  automationByline,
  draftScheduleLabel,
  projectSubtitle,
  projectTitle,
} from './automation-form-mappers';
import type { Automation } from '../../../../shared/types/automation.types';
import type { AutomationDraft } from '../../core/state/automation.store';

describe('automation-form-mappers', () => {
  it('labels one-time and cron drafts', () => {
    const oneTime: AutomationDraft = {
      name: 'once',
      prompt: 'go',
      scheduleType: 'oneTime',
      runAtIso: '2026-09-02T09:00:00.000Z',
      timezone: 'UTC',
    };
    expect(draftScheduleLabel(oneTime)).not.toBe('Once');
    expect(draftScheduleLabel({
      ...oneTime,
      runAtIso: 'not-a-date',
    })).toBe('Once');
    expect(draftScheduleLabel({
      name: 'cron',
      prompt: 'go',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
    })).not.toBe('Schedule');
  });

  it('prefers description then last path segment for bylines', () => {
    const automation = {
      description: '  nightly backup  ',
      action: { workingDirectory: '/Users/suas/work/app' },
    } as Automation;
    expect(automationByline(automation)).toBe('nightly backup');
    expect(automationByline({
      ...automation,
      description: '',
    })).toBe('app');
  });

  it('collapses home prefixes in project titles and subtitles', () => {
    expect(projectTitle('/Users/suas/work/app')).toBe('app');
    expect(projectTitle('   ')).toBe('No workspace');
    expect(projectSubtitle('/Users/suas/work/app')).toBe('~/work/app');
    expect(projectSubtitle('')).toBe('Automations without a working directory');
  });
});
