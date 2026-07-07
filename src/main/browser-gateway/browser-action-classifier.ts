import type {
  BrowserActionClass,
  BrowserElementContext,
} from '@contracts/types/browser';

export interface BrowserActionClassificationInput {
  toolName: string;
  actionHint?: string;
  elementContext?: BrowserElementContext;
}

export interface BrowserFieldClassificationInput {
  selector: string;
  actionHint?: string;
  elementContext?: BrowserElementContext;
}

export interface BrowserActionClassification {
  actionClass: BrowserActionClass;
  hardStop: boolean;
  reason?: string;
}

const CREDENTIAL_WORDS = [
  'password',
  'passkey',
  'token',
  'secret',
  'recovery code',
  'two-factor',
  'two factor',
  '2fa',
  'otp',
  'captcha',
  'verification code',
];

// Payment fields are NEVER automatable, even under an autonomous grant — they
// hard-stop AND are never grantable (see grant policy). Detected ahead of the
// credential check so a "card number" field can't be mistaken for a credential.
const PAYMENT_WORDS = [
  'card number',
  'cardholder',
  'card holder',
  'cvv',
  'cvc',
  'security code',
  'expiry',
  'expiration',
  'iban',
  'sort code',
  'account number',
  'card details',
  'payment details',
  'billing address',
];

// Legal declarations / attestations carry legal force (procurement
// self-certifications, exclusion-grounds declarations). They are escalated to a
// human unless the visible text hash is pre-approved for the campaign.
const DECLARATION_WORDS = [
  'i declare',
  'i certify',
  'i confirm that',
  'on behalf of',
  'declaration',
  'i agree that the information',
  'to the best of my knowledge',
  'legally binding',
];

const DESTRUCTIVE_WORDS = [
  'delete',
  'remove',
  'revoke',
  'reset',
  'destroy',
  'permanently',
  'price',
  'security',
  'account settings',
];

const SUBMIT_WORDS = [
  'post',
  'submit',
  'publish',
  'send',
  'save',
  'confirm',
  'invite',
  'purchase',
  'review',
];

export function classifyBrowserAction(
  input: BrowserActionClassificationInput,
): BrowserActionClassification {
  const contextText = textFromContext(input.elementContext);
  const hintText = normalize(input.actionHint ?? '');

  // Payment first: a card/CVV field must never fall through to credential (which
  // has a fill primitive) — payment has no automated path at all.
  if (hasAny(contextText, PAYMENT_WORDS)) {
    return {
      actionClass: 'payment',
      hardStop: true,
      reason: 'payment_field_never_automated',
    };
  }

  if (hasAny(contextText, CREDENTIAL_WORDS)) {
    return {
      actionClass: 'credential',
      hardStop: true,
      reason: 'credential_or_manual_challenge',
    };
  }

  if (hasAny(contextText, DECLARATION_WORDS)) {
    return {
      actionClass: 'submit',
      hardStop: true,
      reason: 'legal_declaration_requires_human_or_preapproval',
    };
  }

  const contextClass = classFromText(contextText);
  const hintClass = classFromText(hintText);
  if (contextClass) {
    return {
      actionClass: contextClass,
      hardStop: false,
    };
  }

  if (hintClass === 'destructive' || hintClass === 'submit') {
    return {
      actionClass: 'unknown',
      hardStop: false,
      reason: 'agent_hint_conflicts_with_inspected_context',
    };
  }

  if (input.toolName === 'browser.upload_file') {
    return { actionClass: 'file-upload', hardStop: false };
  }
  if (input.toolName === 'browser.download_file') {
    return { actionClass: 'file-download', hardStop: false };
  }
  if (
    input.toolName === 'browser.click' ||
    input.toolName === 'browser.type' ||
    input.toolName === 'browser.select' ||
    input.toolName === 'browser.fill_form'
  ) {
    return { actionClass: 'input', hardStop: false };
  }

  return {
    actionClass: 'unknown',
    hardStop: false,
    reason: 'unclassified_browser_action',
  };
}

export function classifyBrowserFillForm(
  fields: BrowserFieldClassificationInput[],
): BrowserActionClassification {
  let strongest: BrowserActionClassification = {
    actionClass: 'input',
    hardStop: false,
  };

  for (const field of fields) {
    const fieldResult = classifyBrowserAction({
      toolName: 'browser.type',
      actionHint: field.actionHint,
      elementContext: field.elementContext,
    });
    if (fieldResult.actionClass === 'credential' || fieldResult.actionClass === 'unknown') {
      return fieldResult;
    }
    if (fieldResult.actionClass === 'destructive') {
      strongest = fieldResult;
    } else if (
      strongest.actionClass !== 'destructive' &&
      fieldResult.actionClass === 'submit'
    ) {
      strongest = fieldResult;
    }
  }

  return strongest;
}

function classFromText(text: string): BrowserActionClass | null {
  if (hasAny(text, DESTRUCTIVE_WORDS)) {
    return 'destructive';
  }
  if (hasAny(text, SUBMIT_WORDS)) {
    return 'submit';
  }
  return null;
}

function textFromContext(context?: BrowserElementContext): string {
  if (!context) {
    return '';
  }
  return normalize(
    [
      context.role,
      context.accessibleName,
      context.visibleText,
      context.inputType,
      context.inputName,
      context.placeholder,
      context.label,
      context.formAction,
      context.nearbyText,
      ...Object.values(context.attributes ?? {}),
    ]
      .filter(Boolean)
      .join(' '),
  );
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ');
}

function hasAny(value: string, words: string[]): boolean {
  return words.some((word) => value.includes(word));
}
