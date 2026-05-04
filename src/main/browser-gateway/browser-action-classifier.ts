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

  if (hasAny(contextText, CREDENTIAL_WORDS)) {
    return {
      actionClass: 'credential',
      hardStop: true,
      reason: 'credential_or_manual_challenge',
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
