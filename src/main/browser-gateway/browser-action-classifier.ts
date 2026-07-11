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

/**
 * Reasons for a credential-class hard stop, refined so the action guard can
 * route captcha and 2FA to the batch escalation queue while a real password
 * field stays on the per-action approval path. All three keep actionClass
 * 'credential' + hardStop true, so grant / auto-approve / grant-policy behaviour
 * is unchanged — only the reason string differs.
 */
export const CAPTCHA_CHALLENGE_REASON = 'captcha_challenge';
export const TWO_FACTOR_CHALLENGE_REASON = 'two_factor_challenge';
export const CREDENTIAL_CHALLENGE_REASON = 'credential_or_manual_challenge';
/** A legal declaration / attestation (submit-class hard stop). */
export const LEGAL_DECLARATION_REASON = 'legal_declaration_requires_human_or_preapproval';
/**
 * Bank-identity (financial_identity) and sensitive-identity fields hard-stop the
 * RAW type/click path — they are fillable ONLY through the secure secret broker
 * (`browser.fill_secret`) under a standing secret-fill authorization, never via
 * an ordinary grant or a raw `browser.type`.
 */
export const FINANCIAL_IDENTITY_REASON = 'financial_identity_requires_secure_broker';
export const SENSITIVE_IDENTITY_REASON = 'sensitive_identity_requires_secure_broker';

const CAPTCHA_WORDS = ['captcha'];
const TWO_FACTOR_WORDS = [
  'two-factor',
  'two factor',
  '2fa',
  'otp',
  'verification code',
  'recovery code',
];
const PASSWORD_WORDS = ['password', 'passkey', 'token', 'secret'];

// Payment fields are NEVER automatable, even under an autonomous grant — they
// hard-stop AND are never grantable (see grant policy). Detected ahead of the
// credential check so a "card number" field can't be mistaken for a credential.
//
// Split into card-payment vs bank-identity cues. Crucially, an EXPIRY DATE is
// NOT a payment cue on its own: insurance certificates, accreditations, identity
// documents and contracts all carry expiry dates, so a lone expiry field (and
// the Save button beside it) must classify as ordinary. A card expiry is still
// caught contextually — a form that pairs an expiry with a card field is payment
// (see classifyBrowserFillForm).
const CARD_PAYMENT_WORDS = [
  'card number',
  'cardholder',
  'card holder',
  'credit card',
  'debit card',
  'card details',
  'card security code',
  'cvv',
  'cvc',
  'security code',
];

const PAYMENT_WORDS = CARD_PAYMENT_WORDS;

// Bank-identity fields (supplier onboarding) — financial_identity. NOT payment:
// a supplier bank form is an identity/onboarding form, not a monetary
// transaction. Hard-stopped from raw typing; fillable only via the secret broker
// under a secret-fill authorization.
const BANK_IDENTITY_WORDS = ['iban', 'bic', 'swift', 'sort code', 'account number'];

// Sensitive personal/legal identifiers — sensitive_identity. Same broker-only
// treatment as financial_identity.
const SENSITIVE_IDENTITY_WORDS = [
  'national insurance',
  'ni number',
  'social security',
  'passport number',
  'tax identifier',
  'tax id',
  'utr',
  'vat number',
];

// Expiry cues are only a payment signal when paired with a card field in the
// same form (contextual detection). On their own they are ordinary.
const EXPIRY_WORDS = ['expiry', 'expiration', 'valid until', 'valid thru'];

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
  // has a fill primitive) — genuine payment has no automated path at all.
  if (hasAny(contextText, PAYMENT_WORDS)) {
    return {
      actionClass: 'payment',
      hardStop: true,
      reason: 'payment_field_never_automated',
    };
  }

  // Bank-identity + sensitive-identity fields: hard-stop the RAW path so a secret
  // can never be typed via an ordinary tool. They are fillable ONLY through the
  // secret broker under a secret-fill authorization (which bypasses the classifier
  // the same way fill_credential does).
  if (hasAny(contextText, BANK_IDENTITY_WORDS)) {
    return { actionClass: 'financial_identity', hardStop: true, reason: FINANCIAL_IDENTITY_REASON };
  }
  if (hasAny(contextText, SENSITIVE_IDENTITY_WORDS)) {
    return { actionClass: 'sensitive_identity', hardStop: true, reason: SENSITIVE_IDENTITY_REASON };
  }

  // Captcha and 2FA are credential-class hard stops (unchanged), but carry
  // distinct reasons so the action guard can park them to the batch escalation
  // queue rather than block on a per-action approval. A real password/token
  // field keeps the generic reason and the per-action approval path.
  if (hasAny(contextText, CAPTCHA_WORDS)) {
    return { actionClass: 'credential', hardStop: true, reason: CAPTCHA_CHALLENGE_REASON };
  }
  if (hasAny(contextText, TWO_FACTOR_WORDS)) {
    return { actionClass: 'credential', hardStop: true, reason: TWO_FACTOR_CHALLENGE_REASON };
  }
  if (hasAny(contextText, PASSWORD_WORDS)) {
    return { actionClass: 'credential', hardStop: true, reason: CREDENTIAL_CHALLENGE_REASON };
  }

  if (hasAny(contextText, DECLARATION_WORDS)) {
    return {
      actionClass: 'submit',
      hardStop: true,
      reason: LEGAL_DECLARATION_REASON,
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
    // A payment (card / bank-identity) or credential field anywhere in the form
    // hard-stops the whole fill_form: the batch is atomic, so one unsafe field
    // taints the lot. Payment was previously not surfaced here at all.
    if (
      fieldResult.actionClass === 'payment' ||
      fieldResult.actionClass === 'financial_identity' ||
      fieldResult.actionClass === 'sensitive_identity' ||
      fieldResult.actionClass === 'credential' ||
      fieldResult.actionClass === 'unknown'
    ) {
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

  // Contextual card-expiry: an expiry date is ordinary alone, but an expiry
  // PLUS a card cue in the same form is a genuine payment surface even if the
  // card cue only appeared in an actionHint. (A card field in element context
  // is already caught per-field above; this covers the split-signal case.)
  const texts = fields.map(
    (field) => `${textFromContext(field.elementContext)} ${normalize(field.actionHint ?? '')}`,
  );
  const hasCardCue = texts.some((text) => hasAny(text, CARD_PAYMENT_WORDS));
  const hasExpiryCue = texts.some((text) => hasAny(text, EXPIRY_WORDS));
  if (hasCardCue && hasExpiryCue) {
    return { actionClass: 'payment', hardStop: true, reason: 'payment_field_never_automated' };
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
