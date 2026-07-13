import { describe, expect, it } from 'vitest';
import type { MobileAttachmentDto, MobileSessionPlan } from '../../core/models';
import {
  buildCreateInstanceRequest,
  canStartSession,
  newSessionSuccessRoute,
  providerDisplayName,
  reasoningOptionsForProvider,
  sessionPlanSummary,
  shouldPresentDirectorySheet,
} from './new-session.presentation';

const plan: MobileSessionPlan = {
  provider: 'codex',
  providerLabel: 'Codex',
  model: 'gpt-5.6',
  modelLabel: 'GPT-5.6',
  reasoningEffort: 'xhigh',
  reasoningEffortLabel: 'Extra High',
};

describe('new session presentation', () => {
  it('summarizes the host-resolved model and reasoning', () => {
    expect(sessionPlanSummary(plan)).toBe('GPT-5.6 · Extra High');
    expect(sessionPlanSummary(null)).toBe('Resolving session settings');
  });

  it('uses readable provider labels', () => {
    expect(providerDisplayName('auto')).toBe('Auto');
    expect(providerDisplayName('copilot')).toBe('Copilot');
    expect(providerDisplayName('local_model')).toBe('Local Model');
  });

  it('only presents the directory sheet automatically for global New', () => {
    expect(shouldPresentDirectorySheet('', ['/work/aio'])).toBe(true);
    expect(shouldPresentDirectorySheet('/work/aio', ['/work/aio'])).toBe(false);
    expect(shouldPresentDirectorySheet('', [])).toBe(false);
  });

  it('requires an online host, directory, and non-busy state but allows an empty prompt', () => {
    expect(canStartSession({ online: true, directory: '/work/aio', busy: false })).toBe(true);
    expect(canStartSession({ online: false, directory: '/work/aio', busy: false })).toBe(false);
    expect(canStartSession({ online: true, directory: '', busy: false })).toBe(false);
    expect(canStartSession({ online: true, directory: '/work/aio', busy: true })).toBe(false);
  });

  it('builds the existing create payload without empty optional fields', () => {
    const attachment: MobileAttachmentDto = {
      name: 'screen.jpg',
      type: 'image/jpeg',
      size: 12,
      data: 'data:image/jpeg;base64,AA==',
    };

    expect(
      buildCreateInstanceRequest({
        directory: '/work/aio',
        provider: 'codex',
        model: 'gpt-5.6',
        reasoningEffort: 'xhigh',
        prompt: '  Polish mobile UX  ',
        attachments: [attachment],
      }),
    ).toEqual({
      workingDirectory: '/work/aio',
      provider: 'codex',
      model: 'gpt-5.6',
      reasoningEffort: 'xhigh',
      initialPrompt: 'Polish mobile UX',
      attachments: [attachment],
    });

    expect(
      buildCreateInstanceRequest({
        directory: '/work/aio',
        provider: 'auto',
        model: undefined,
        reasoningEffort: undefined,
        prompt: ' ',
        attachments: [],
      }),
    ).toEqual({
      workingDirectory: '/work/aio',
      provider: 'auto',
      model: undefined,
      reasoningEffort: undefined,
      initialPrompt: undefined,
      attachments: undefined,
    });
  });

  it('offers the same provider-specific effort levels as the desktop picker', () => {
    expect(reasoningOptionsForProvider('claude').map((option) => option.id)).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'workflow',
    ]);
    expect(reasoningOptionsForProvider('codex').map((option) => option.id)).toEqual([
      'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh',
    ]);
    expect(reasoningOptionsForProvider('gemini')).toEqual([]);
  });

  it('keeps the existing successful-session route', () => {
    expect(newSessionSuccessRoute('/work/aio', 'created-1')).toEqual([
      '/projects',
      '/work/aio',
      'sessions',
      'created-1',
    ]);
    expect(newSessionSuccessRoute('', 'created-2')).toEqual([
      '/projects',
      '__no_workspace__',
      'sessions',
      'created-2',
    ]);
  });
});
