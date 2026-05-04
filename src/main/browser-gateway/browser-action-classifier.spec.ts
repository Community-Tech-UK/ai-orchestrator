import { describe, expect, it } from 'vitest';
import {
  classifyBrowserAction,
  classifyBrowserFillForm,
} from './browser-action-classifier';

describe('browser-action-classifier', () => {
  it('escalates submit and destructive cues from inspected element context', () => {
    expect(
      classifyBrowserAction({
        toolName: 'browser.click',
        actionHint: 'click normal button',
        elementContext: {
          role: 'button',
          accessibleName: 'Submit for review',
          formAction: 'https://play.google.com/submit',
        },
      }).actionClass,
    ).toBe('submit');

    expect(
      classifyBrowserAction({
        toolName: 'browser.click',
        actionHint: 'save',
        elementContext: {
          role: 'button',
          accessibleName: 'Save',
          nearbyText: 'Delete this app permanently',
          attributes: {
            'data-action': 'delete',
          },
        },
      }).actionClass,
    ).toBe('destructive');
  });

  it('treats credential, 2FA, and captcha fields as credential hard stops', () => {
    for (const elementContext of [
      { inputType: 'password', label: 'Password' },
      { inputName: 'otp', label: 'Two-factor code' },
      { label: 'CAPTCHA response' },
    ]) {
      expect(
        classifyBrowserAction({
          toolName: 'browser.type',
          elementContext,
        }),
      ).toMatchObject({
        actionClass: 'credential',
        hardStop: true,
      });
    }
  });

  it('does not trust conflicting agent hints', () => {
    const result = classifyBrowserAction({
      toolName: 'browser.click',
      actionHint: 'delete app',
      elementContext: {
        role: 'button',
        accessibleName: 'Continue',
      },
    });

    expect(result.actionClass).toBe('unknown');
  });

  it('classifies fill_form atomically and blocks when any field is unsafe', () => {
    const result = classifyBrowserFillForm([
      {
        selector: '#title',
        elementContext: {
          label: 'Title',
          inputType: 'text',
        },
      },
      {
        selector: '#password',
        elementContext: {
          label: 'Password',
          inputType: 'password',
        },
      },
    ]);

    expect(result).toMatchObject({
      actionClass: 'credential',
      hardStop: true,
    });
  });
});
