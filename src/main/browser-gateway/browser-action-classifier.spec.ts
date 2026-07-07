import { describe, expect, it } from 'vitest';
import {
  classifyBrowserAction,
  classifyBrowserFillForm,
  CAPTCHA_CHALLENGE_REASON,
  TWO_FACTOR_CHALLENGE_REASON,
  CREDENTIAL_CHALLENGE_REASON,
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

  it('gives captcha, 2FA and password distinct reasons so the guard can queue only captcha/2FA', () => {
    expect(
      classifyBrowserAction({ toolName: 'browser.type', elementContext: { label: 'CAPTCHA response' } }),
    ).toMatchObject({ actionClass: 'credential', hardStop: true, reason: CAPTCHA_CHALLENGE_REASON });

    expect(
      classifyBrowserAction({
        toolName: 'browser.type',
        elementContext: { inputName: 'otp', label: 'Two-factor code' },
      }),
    ).toMatchObject({ actionClass: 'credential', hardStop: true, reason: TWO_FACTOR_CHALLENGE_REASON });

    // A real password field keeps the generic reason and the approval path.
    expect(
      classifyBrowserAction({ toolName: 'browser.type', elementContext: { inputType: 'password', label: 'Password' } }),
    ).toMatchObject({ actionClass: 'credential', hardStop: true, reason: CREDENTIAL_CHALLENGE_REASON });
  });

  it('hard-stops payment fields as a distinct payment class (never a credential)', () => {
    for (const elementContext of [
      { label: 'Card number' },
      { inputName: 'cvv', label: 'CVV' },
      { label: 'Sort code' },
      { label: 'IBAN' },
    ]) {
      expect(
        classifyBrowserAction({ toolName: 'browser.type', elementContext }),
      ).toMatchObject({ actionClass: 'payment', hardStop: true });
    }
  });

  it('hard-stops legal declarations for human review / pre-approval', () => {
    expect(
      classifyBrowserAction({
        toolName: 'browser.click',
        elementContext: {
          role: 'checkbox',
          accessibleName: 'I declare that the information is accurate',
        },
      }),
    ).toMatchObject({ actionClass: 'submit', hardStop: true });
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

  it('classifies dialog-scoped Post, Send, and Publish buttons as submit actions', () => {
    for (const accessibleName of ['Post', 'Send', 'Publish']) {
      expect(
        classifyBrowserAction({
          toolName: 'browser.click',
          actionHint: 'click button',
          elementContext: {
            role: 'button',
            accessibleName,
            nearbyText: 'Create post dialog',
            attributes: {
              'aria-modal': 'true',
              'data-dialog-role': 'dialog',
            },
          },
        }).actionClass,
      ).toBe('submit');
    }
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
