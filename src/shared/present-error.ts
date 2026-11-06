import { accountFamilyName, providerName } from './display-names';

export type ErrorCategory = 'quota' | 'auth' | 'network' | 'provider-crash' | 'concurrency' | 'tool-server' | 'cancelled' | 'unknown';

export interface ErrorPresentationContext {
  provider?: string;
  account?: string;
  resetAt?: number;
  now?: number;
  allowance?: 'weekly' | 'daily' | 'session';
  toolServer?: string;
  maxSessions?: number;
  waitedMs?: number;
  retrying?: boolean;
}

export interface PresentedError {
  category: ErrorCategory;
  headline: string;
  whatToDo: string;
  action?: 'retry' | 'switch-account' | 'sign-in';
  rawDetail: string;
}

const CATEGORIES = new Set<string>(['quota', 'auth', 'network', 'provider-crash', 'concurrency', 'tool-server', 'cancelled', 'unknown']);
const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode', 'ollama']);

/** Raw diagnostics stay in Details; closed copy may include the supplied account and server labels. */
export function presentError(codeOrError: unknown, context: ErrorPresentationContext = {}): PresentedError {
  const rawDetail = errorDetail(codeOrError);
  const category = errorCategory(codeOrError);
  const known = Boolean(context.provider && PROVIDERS.has(context.provider));
  // Concurrency names the tool's process; allowances and sign-in name the account family.
  const provider = known ? providerName(context.provider) : 'AI';
  const accountOwner = known ? accountFamilyName(context.provider) : provider;
  const account = displayLabel(context.account);
  let headline: string;
  let advice: string;
  let action: PresentedError['action'];
  switch (category) {
    case 'quota': {
      const owner = account ? `Your ${account} ${accountOwner} account` : `Your ${accountOwner} account`;
      const allowance = context.allowance === 'weekly' ? 'weekly allowance'
        : context.allowance === 'daily' ? 'daily allowance' : 'current allowance';
      headline = `${owner} has used its ${allowance}.${resetSentence(context)}`;
      advice = 'Wait for the allowance to reset, or switch account.';
      action = 'switch-account';
      break;
    }
    case 'auth':
      headline = `Signed out of ${account || accountOwner}.`;
      advice = 'Sign in to continue.';
      action = 'sign-in';
      break;
    case 'network':
      headline = `The connection to ${provider} was interrupted.`;
      advice = 'Check your connection, then try again.';
      action = 'retry';
      break;
    case 'provider-crash':
      headline = `${provider} stopped before this turn finished.`;
      advice = 'Continue from where it stopped. Your message and the work above are kept.';
      action = 'retry';
      break;
    case 'concurrency': {
      const maximum = finitePositive(context.maxSessions);
      const waited = finitePositive(context.waitedMs);
      const seconds = waited ? Math.ceil(waited / 1000) : undefined;
      const duration = waited === 60_000 ? 'a minute' : seconds ? `${seconds} second${seconds === 1 ? '' : 's'}` : undefined;
      headline = `${provider} is already running ${maximum ? `its maximum of ${maximum} sessions` : 'its maximum number of sessions'}${duration ? `; this one waited ${duration}` : ''}.`;
      advice = 'Wait for another session to finish, then try again.';
      action = 'retry';
      break;
    }
    case 'tool-server': {
      const server = displayLabel(context.toolServer);
      headline = `A tool server didn't start for this ${provider} session${server ? `: ${server}` : ''}.`;
      advice = 'Check the tool server in Settings, then try again.';
      action = 'retry';
      break;
    }
    case 'cancelled':
      headline = 'This turn was stopped. Your message and the work above are kept.';
      advice = 'Continue when you are ready.';
      action = 'retry';
      break;
    default:
      headline = `${provider} couldn't finish this request.`;
      advice = 'Check Details, then try again. Your message and the work above are kept.';
      action = 'retry';
  }
  return {
    category, headline,
    whatToDo: context.retrying ? 'No action needed: Harness is already retrying.' : `What to do: ${advice}`,
    ...(context.retrying ? {} : { action }), rawDetail,
  };
}

/** Raw diagnostic text for a failure. Visible copy presents it under Details, never as the headline. */
export function rawErrorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function errorDetail(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const message = (value as Record<string, unknown>)['message'];
    if (typeof message === 'string') return message;
  }
  return '';
}

function errorCategory(value: unknown): ErrorCategory {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const code = typeof value === 'string' ? value : record?.['code'];
  if (typeof code === 'string' && CATEGORIES.has(code)) return code as ErrorCategory;
  if (typeof code === 'string') {
    if (['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EPIPE'].includes(code)) return 'network';
    if (['AUTH_REQUIRED', 'UNAUTHORIZED'].includes(code)) return 'auth';
    if (['QUOTA_EXCEEDED', 'RATE_LIMITED'].includes(code)) return 'quota';
    if (['ABORT_ERR', 'ERR_CANCELED'].includes(code)) return 'cancelled';
  }
  return 'unknown';
}

function displayLabel(value: string | undefined): string {
  return typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ').trim().slice(0, 80) : '';
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function resetSentence(context: ErrorPresentationContext): string {
  const resetAt = context.resetAt;
  if (resetAt === undefined || !finitePositive(resetAt)) return '';
  const now = typeof context.now === 'number' && Number.isFinite(context.now) ? context.now : Date.now();
  const date = new Date(resetAt);
  if (!Number.isFinite(date.getTime())) return '';
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (resetAt - now <= 12 * 60 * 60_000) return ` It resets at ${time}.`;
  const day = date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return ` It resets on ${day} at ${time}.`;
}
