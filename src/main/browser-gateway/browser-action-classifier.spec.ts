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

  it('hard-stops genuine card-payment fields as a distinct payment class (never a credential)', () => {
    for (const elementContext of [{ label: 'Card number' }, { inputName: 'cvv', label: 'CVV' }]) {
      expect(
        classifyBrowserAction({ toolName: 'browser.type', elementContext }),
      ).toMatchObject({ actionClass: 'payment', hardStop: true });
    }
  });

  // Supplier bank onboarding is financial_identity, NOT payment: it is an
  // identity/onboarding form, not a monetary transaction. Hard-stopped from raw
  // typing (broker-only), but a distinct, grantable-via-broker class.
  it('classifies bank-identity fields as financial_identity (broker-only, not payment)', () => {
    for (const elementContext of [
      { label: 'Sort code' },
      { label: 'IBAN' },
      { label: 'Account number' },
      { label: 'BIC / SWIFT' },
    ]) {
      expect(
        classifyBrowserAction({ toolName: 'browser.type', elementContext }),
      ).toMatchObject({ actionClass: 'financial_identity', hardStop: true });
    }
  });

  it('classifies tax / national-id fields as sensitive_identity (broker-only)', () => {
    for (const elementContext of [
      { label: 'VAT number' },
      { label: 'National Insurance number' },
      { label: 'Unique Taxpayer Reference (UTR)' },
    ]) {
      expect(
        classifyBrowserAction({ toolName: 'browser.type', elementContext }),
      ).toMatchObject({ actionClass: 'sensitive_identity', hardStop: true });
    }
  });

  // Regression for the Constellia insurance-upload false positive: an expiry
  // date on its own is ordinary (insurance certificates, accreditations, IDs and
  // contracts all carry them). It must NOT be classified payment.
  it('does not classify a lone expiry date as payment', () => {
    for (const elementContext of [
      { label: 'Insurance certificate expiry date', inputType: 'text' },
      { inputName: 'expiryDate', placeholder: 'Expiration date', inputType: 'date' },
      { label: 'Policy valid until' },
    ]) {
      const result = classifyBrowserAction({ toolName: 'browser.type', elementContext });
      expect(result.actionClass).not.toBe('payment');
      expect(result.hardStop).toBe(false);
    }
  });

  // The other half of the same Constellia failure: the ordinary "Save" button on
  // a document-upload section sat next to an expiry field and was mis-read as
  // payment. With expiry no longer a payment cue it must classify as an ordinary
  // (non-hard-stop) submit.
  it('classifies a section Save button next to an expiry field as an ordinary submit', () => {
    const result = classifyBrowserAction({
      toolName: 'browser.click',
      actionHint: 'save section',
      elementContext: {
        role: 'button',
        accessibleName: 'Save',
        nearbyText: 'Insurance certificate. Expiry date. Upload document.',
      },
    });
    expect(result).toMatchObject({ actionClass: 'submit', hardStop: false });
  });

  // A real payment surface still hard-blocks: a card field remains payment even
  // when it appears inside a multi-field fill_form.
  it('hard-stops a fill_form that contains a genuine card-payment field', () => {
    const result = classifyBrowserFillForm([
      { selector: '#name', elementContext: { label: 'Full name', inputType: 'text' } },
      { selector: '#card', elementContext: { label: 'Card number', inputType: 'text' } },
      { selector: '#exp', elementContext: { label: 'Expiry date', inputType: 'text' } },
    ]);
    expect(result).toMatchObject({ actionClass: 'payment', hardStop: true });
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

  describe('navigation-link semantics', () => {
    const link = (overrides: Record<string, unknown> = {}) => classifyBrowserAction({
      toolName: 'browser.click',
      elementContext: {
        role: 'link',
        attributes: { href: '/procurement/activities/PA23-07A' },
        ...overrides,
      },
    });

    it('does not treat a breadcrumb containing "Publish" and "Invite" as a submit', () => {
      // The exact ProContract breadcrumb that blocked the live task.
      expect(link({
        accessibleName: 'PA23 - 07A - Publish Tender Pack (Auto Invite)',
      })).toMatchObject({
        actionClass: 'navigate',
        hardStop: false,
        reason: 'navigation_link_semantics',
      });
    });

    it.each([
      ['invite', 'Invite suppliers list'],
      ['send', 'Sent messages'],
      ['review', 'Review responses'],
      ['publish', 'Published notices'],
      ['price', 'Pricing schedule'],
      ['security', 'Security questionnaire'],
    ])('treats a navigation link containing "%s" as navigation', (_word, accessibleName) => {
      expect(link({ accessibleName })).toMatchObject({ actionClass: 'navigate' });
    });

    it.each([
      ['unsubscribe', 'Unsubscribe from notifications'],
      ['withdraw', 'Withdraw interest'],
      ['delete', 'Delete this response'],
      ['remove', 'Remove supplier'],
      ['revoke', 'Revoke access'],
    ])('keeps a link containing "%s" gated', (_word, accessibleName) => {
      const result = link({ accessibleName });
      expect(result.actionClass).not.toBe('navigate');
      expect(['submit', 'destructive']).toContain(result.actionClass);
    });

    it('keeps an effectful destination gated even when the label looks harmless', () => {
      const result = link({
        accessibleName: 'Manage notifications',
        attributes: { href: '/account/unsubscribe?token=abc' },
      });

      expect(result.actionClass).not.toBe('navigate');
    });

    it('requires a real destination — a link with no href stays gated', () => {
      const result = classifyBrowserAction({
        toolName: 'browser.click',
        elementContext: { role: 'link', accessibleName: 'Publish tender pack' },
      });

      expect(result).toMatchObject({ actionClass: 'submit' });
    });

    it('does not accept a javascript: href as navigation', () => {
      expect(link({
        accessibleName: 'Publish tender pack',
        attributes: { href: 'javascript:doPublish()' },
      })).toMatchObject({ actionClass: 'submit' });
    });

    it('does not downgrade a button that merely looks like a link', () => {
      expect(classifyBrowserAction({
        toolName: 'browser.click',
        elementContext: {
          role: 'button',
          accessibleName: 'Publish tender pack',
          attributes: { href: '/procurement/publish' },
        },
      })).toMatchObject({ actionClass: 'submit' });
    });

    it('does not downgrade a link that submits a form', () => {
      expect(link({
        accessibleName: 'Publish tender pack',
        formAction: '/procurement/publish',
      })).toMatchObject({ actionClass: 'submit' });
    });

    it('keeps credential and payment hard stops ahead of navigation semantics', () => {
      expect(link({
        accessibleName: 'Card number help',
        nearbyText: 'card number',
      })).toMatchObject({ actionClass: 'payment', hardStop: true });

      expect(link({
        accessibleName: 'Password help',
      })).toMatchObject({ actionClass: 'credential', hardStop: true });
    });
  });
});
