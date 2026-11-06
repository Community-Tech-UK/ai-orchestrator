/**
 * Plain-language presentation of a pending browser approval.
 *
 * Every browser request uses the saved-login card's layout: one sentence saying
 * what will happen, then the reason, which website and which computer, with the
 * raw tool name, selector, scope and profile kept under Details. This file turns
 * a `BrowserApprovalRequest` into exactly that, and decides which of the three
 * allow buttons apply. It reuses the permission bar's grant rules
 * (`browser-approvals-banner.rules`) so the card can never mint a grant the bar
 * or the Browser page would refuse. It changes no approval authority.
 *
 * Where the words come from, so none of them is invented:
 * - The reason is only what the agent said (`requestReason`). Without one the
 *   card says why the action needs a decision, from its action class, and
 *   labels it as that.
 * - The computer is the one the gateway worked out from the tab or the profile
 *   (`computerId`), named by `computerName` from the roster. Nothing is guessed
 *   from the profile's name.
 * - A shared tab's element description is the agent's own hint; a managed
 *   profile's is read from the page. Details says which.
 */

import type {
  BrowserActionClass,
  BrowserApprovalRequest,
  BrowserElementContext,
  BrowserGrantProposal,
} from '@contracts/types/browser';
import { computerName } from '../../../../shared/display-names';
import { PERMISSION_SCOPE_WORDS } from '../../../../shared/permissions/permission-scope-presentation';
export { browserApprovalFailureText } from '../../core/state/browser-approvals-banner.rules';
import {
  bannerConfirmationPhrase,
  bannerGrantModes,
  bannerGrantRequiresConfirmation,
  buildBannerGrant,
  credentialAccessMovement,
  credentialAccessPurpose,
  credentialAccessWords,
  type BannerGrantMode,
  type CredentialAccessDuration,
} from '../../core/state/browser-approvals-banner.rules';

export type BrowserAllowChoiceId = 'once' | 'session' | 'without-asking';

/** `per_action` grants are consumed by the next action, so "once" is literally true. */
const MODE_FOR_CHOICE: Readonly<Record<BrowserAllowChoiceId, BannerGrantMode>> = {
  once: 'per_action',
  session: 'session',
  'without-asking': 'autonomous',
};
const CHOICE_ORDER: readonly BrowserAllowChoiceId[] = ['once', 'session', 'without-asking'];
const AUDIT_REASON: Readonly<Record<BrowserAllowChoiceId, string>> = {
  once: 'Allowed once from session page',
  session: 'Allowed for session from session page',
  'without-asking': 'Allowed without asking from session page',
};

export interface BrowserApprovalFact {
  readonly label: string;
  readonly value: string;
}

export interface BrowserAllowChoice {
  readonly id: BrowserAllowChoiceId;
  readonly label: string;
  /** Plain description of what the button covers, for its tooltip. */
  readonly hint: string;
  /** Exactly what a click sends to the gateway. */
  readonly grant: BrowserGrantProposal;
  /** True when the grant covers submitting or deleting, which needs the typed phrase. */
  readonly needsPhrase: boolean;
  readonly auditReason: string;
}

export type BrowserApprovalKind = 'action' | 'handoff' | 'saved-login';

export interface BrowserApprovalView {
  readonly approval: BrowserApprovalRequest;
  readonly kind: BrowserApprovalKind;
  readonly kindLabel: string;
  readonly headline: string;
  readonly facts: readonly BrowserApprovalFact[];
  readonly details: readonly BrowserApprovalFact[];
  /** Empty for a saved login (it has its own length control) and for requests that need review. */
  readonly choices: readonly BrowserAllowChoice[];
  /** One calm sentence when the usual three buttons do not all apply. */
  readonly note: string | null;
  /** The text to type before a button that covers submitting or deleting works. */
  readonly phrase: string | null;
}

export interface BrowserApprovalContext {
  /** What the computer list knows about a remote computer: its own name, and what kind it is. */
  node?: (nodeId: string) => { name?: string | null; platform?: string | null } | undefined;
  /** `process.platform` of the computer Harness runs on, to say "this Mac" or "this PC". */
  localPlatform?: string;
  formatTime?: (timestamp: number) => string;
  /** The length the user has picked for a saved-login request. */
  credentialDuration?: CredentialAccessDuration;
}

const HANDOFF_LABEL = 'Done, carry on';
const HANDOFF_NOTE = "Approving only tells the agent to carry on. It doesn't allow anything else.";
const HANDOFF_WHY = 'You need to do this step by hand.';
const REVIEW_NOTE = "You can't allow this one from here. Deny it, or review it on the Browser page.";
const UNKNOWN_NOTE = 'You can only allow this one action at a time.';

const WHY_BY_CLASS: Readonly<Record<BrowserActionClass, string>> = {
  read: "It reads what's on the page.",
  navigate: 'It moves the browser to another page.',
  input: 'It types or clicks on the page.',
  credential: 'It uses a saved sign-in on the page.',
  'file-upload': 'It sends a file from your computer to the website.',
  'file-download': 'It saves a file from the website to your computer.',
  submit: "It sends what's on the page to the website.",
  destructive: 'It could delete or remove something.',
  financial_identity: "It involves bank or tax details, which a normal approval can't cover.",
  sensitive_identity: "It involves ID details, which a normal approval can't cover.",
  payment: 'It involves a payment, which Harness never makes for you.',
  unknown: "Harness couldn't tell what this does, so it asks every time.",
};

const ACTIVITIES: Readonly<Record<BrowserActionClass, readonly string[]>> = {
  read: ['reading pages'],
  navigate: ['moving between pages'],
  input: ['typing', 'clicking'],
  credential: ['using saved logins'],
  'file-upload': ['uploading files'],
  'file-download': ['downloading files'],
  submit: ['submitting forms'],
  destructive: ['deleting things'],
  financial_identity: ['handling bank or tax details'],
  sensitive_identity: ['handling ID details'],
  payment: ['handling payments'],
  unknown: ["actions Harness couldn't classify"],
};

export function presentBrowserApproval(
  approval: BrowserApprovalRequest,
  ctx: BrowserApprovalContext = {},
): BrowserApprovalView {
  if (approval.credentialAccess) return presentSavedLogin(approval, approval.credentialAccess, ctx);

  const site = siteOf(approval);
  const computer = computerOf(approval, ctx);
  const handoff = isManualHandoff(approval);
  const grantRequest = approval.toolName === 'browser.request_grant';
  const choices = handoff ? [handoffChoice(approval)] : allowChoices(approval, site);
  const note = handoff
    ? HANDOFF_NOTE
    : choices.length === 0 ? REVIEW_NOTE : approval.actionClass === 'unknown' ? UNKNOWN_NOTE : null;
  const format = ctx.formatTime ?? ((timestamp: number) => new Date(timestamp).toLocaleString());
  const element = describeElement(approval.elementContext);

  return {
    approval,
    kind: handoff ? 'handoff' : 'action',
    kindLabel: 'Browser action',
    headline: place(
      handoff ? handoffPhrase(approval) : grantRequest ? 'Get permission to work' : actionPhrase(approval),
      site,
      computer?.name,
    ),
    facts: [
      ...reasonFacts(approval, handoff, grantRequest),
      ...(site ? [{ label: 'Website', value: site }] : []),
      ...(computer ? [{ label: 'Computer', value: computer.name }] : []),
      { label: 'Reply before', value: format(approval.expiresAt) },
    ],
    details: compact([
      ['Tool', approval.toolName],
      ['Action type', approval.actionClass],
      ['Requested scope', rawScope(approval)],
      ['Page address', approval.url],
      ['Selector', approval.selector],
      // A hand-off's text is the agent's reason when it gave one, so it is not repeated here.
      handoff
        ? ['Message', approval.requestReason ? undefined : element]
        : [elementSource(approval), element],
      ['File', approval.filePath],
      ['File type', approval.detectedFileType],
      ['Upload folders', approval.proposedGrant.uploadRoots?.join(', ')],
      ['Profile', approval.profileId],
      ['Target', approval.targetId],
      ['Computer id', computer?.nodeId],
    ]),
    choices,
    note,
    phrase: choices.some((choice) => choice.needsPhrase) ? bannerConfirmationPhrase(approval) : null,
  };
}

function presentSavedLogin(
  approval: BrowserApprovalRequest,
  access: NonNullable<BrowserApprovalRequest['credentialAccess']>,
  ctx: BrowserApprovalContext,
): BrowserApprovalView {
  const duration = ctx.credentialDuration ?? 'task';
  const site = hostOf(access.origin) ?? access.origin;
  const computer = computerOf(approval, ctx)!;
  const title = `'${access.itemTitle}'`;
  const login = access.purposes.includes('login');
  const code = access.purposes.includes('totp');
  const phrase = login && code
    ? `Sign in to ${site} with ${title} and its one-time code`
    : code ? `Use a one-time code from ${title} on ${site}` : `Sign in to ${site} with ${title}`;
  const format = ctx.formatTime ?? ((timestamp: number) => new Date(timestamp).toLocaleString());
  const lasts = duration === 'task'
    ? `${capitalise(PERMISSION_SCOPE_WORDS.session.lasts)}.`
    : `${capitalise(credentialAccessWords(duration).lasts)}. Any session can use this saved login on ${site} without asking again.`;

  return {
    approval,
    kind: 'saved-login',
    kindLabel: 'Saved login',
    headline: `${phrase} (${computer.name})`,
    facts: [
      { label: 'Session', value: access.sessionName },
      { label: 'Reason', value: access.reason },
      { label: 'Website', value: site },
      { label: 'Computer', value: computer.name },
      { label: 'Access', value: `${credentialAccessPurpose(approval)}. Only this website, computer and saved login.` },
      { label: 'Vault folder', value: credentialAccessMovement(approval) },
      { label: 'Lasts', value: lasts },
      ...(duration === 'task' && access.permissionExpiresAt
        ? [{ label: 'Latest expiry', value: format(access.permissionExpiresAt) }]
        : []),
      { label: 'Reply before', value: format(approval.expiresAt) },
    ],
    details: compact([
      ['Tool', approval.toolName],
      ['Profile', approval.profileId],
      ['Target', approval.targetId],
      ['Scope', access.scope],
      ['Computer id', access.computerId],
      ['Last saved-login error', access.operationError],
    ]),
    choices: [],
    note: null,
    phrase: null,
  };
}

function allowChoices(approval: BrowserApprovalRequest, site: string | null): BrowserAllowChoice[] {
  const modes = bannerGrantModes(approval);
  return CHOICE_ORDER.flatMap((id) => {
    const mode = MODE_FOR_CHOICE[id];
    const grant = modes.includes(mode) ? buildBannerGrant(approval, mode) : null;
    if (!grant) return [];
    return [{
      id,
      label: PERMISSION_SCOPE_WORDS[id].allow,
      hint: choiceHint(id, grant, site),
      grant,
      needsPhrase: bannerGrantRequiresConfirmation(grant),
      auditReason: AUDIT_REASON[id],
    }];
  });
}

/** Approving a hand-off only acknowledges it: the gateway ignores any wider grant. */
function handoffChoice(approval: BrowserApprovalRequest): BrowserAllowChoice {
  return {
    id: 'once',
    label: HANDOFF_LABEL,
    hint: "Tells the agent you've finished your step.",
    grant: { ...approval.proposedGrant, mode: 'per_action', autonomous: false },
    needsPhrase: false,
    auditReason: 'Hand-off acknowledged from session page',
  };
}

function choiceHint(id: BrowserAllowChoiceId, grant: BrowserGrantProposal, site: string | null): string {
  const where = site ? ` on ${site}` : '';
  if (id === 'once') return `Covers just this one action${where}. The next one asks again.`;
  const covers = `Covers ${listWords(activitiesOf(grant.allowedActionClasses))}${where} ${PERMISSION_SCOPE_WORDS[id].lasts}.`;
  return id === 'without-asking' ? `${covers} Meant for runs you're not watching.` : covers;
}

function activitiesOf(classes: readonly BrowserActionClass[]): string[] {
  return [...new Set(classes.flatMap((actionClass) => ACTIVITIES[actionClass]))];
}

function listWords(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** What the agent said comes first; what the action class means follows, so the person can weigh both. */
function reasonFacts(
  approval: BrowserApprovalRequest,
  handoff: boolean,
  grantRequest: boolean,
): BrowserApprovalFact[] {
  const said = approval.requestReason ? [{ label: 'Reason', value: approval.requestReason }] : [];
  if (handoff) return said.length ? said : [{ label: 'Why it needs your OK', value: HANDOFF_WHY }];
  const why = grantRequest
    ? { label: 'Would cover', value: listWords(activitiesOf(approval.proposedGrant.allowedActionClasses)) }
    : { label: 'Why it needs your OK', value: WHY_BY_CLASS[approval.actionClass] };
  return [...said, why];
}

function actionPhrase(approval: BrowserApprovalRequest): string {
  const tool = approval.toolName.replace(/^browser\./, '');
  const target = elementLabel(approval.elementContext);
  switch (tool) {
    case 'click': return `Click ${target ?? 'something on the page'}`;
    case 'type': return `Type into ${target ?? 'a field'}`;
    case 'select': return `Choose an option in ${target ?? 'a list'}`;
    case 'fill_form':
    case 'execute_fill_plan': return 'Fill in a form';
    case 'press_key': return 'Press a key';
    case 'navigate': return 'Open a page';
    case 'reload': return 'Reload the page';
    case 'upload_file': return `Upload ${baseName(approval.filePath) ?? 'a file'}`;
    case 'download_file': return 'Download a file';
    case 'close_tab':
    case 'close_matching': return 'Close a browser tab';
    case 'fill_credential': return 'Fill in a saved login';
    case 'fill_http_auth': return 'Answer the sign-in prompt from the website';
    default: return `Use the browser: ${tool.replaceAll('_', ' ')}`;
  }
}

function handoffPhrase(approval: BrowserApprovalRequest): string {
  return approval.toolName === 'browser.request_user_login'
    ? 'Wait while you sign in yourself'
    : 'Wait for a step only you can do';
}

function place(phrase: string, site: string | null, computer: string | undefined): string {
  return `${phrase}${site ? ` on ${site}` : ''}${computer ? ` (${computer})` : ''}`;
}

/** Mirrors `isManualHandoff` in the gateway's approval operations. */
function isManualHandoff(approval: BrowserApprovalRequest): boolean {
  return approval.toolName === 'browser.request_user_login' || approval.toolName === 'browser.pause_for_manual_step';
}

/**
 * The computer an approval is about, named the way every other screen names it.
 * The gateway says which one (`computerId`: 'local' or a remote computer's id);
 * the computer list supplies the remote one's own name. A saved login carries
 * its own computer name, which is kept when the list does not know the computer.
 */
function computerOf(
  approval: BrowserApprovalRequest,
  ctx: BrowserApprovalContext,
): { name: string; nodeId?: string } | null {
  const access = approval.credentialAccess;
  const id = access?.computerId ?? approval.computerId;
  if (!id) return null;
  if (id === 'local') return { name: computerName('local', ctx.localPlatform) };
  const node = ctx.node?.(id);
  if (access) return { name: node?.name?.trim() ? computerName(node) : access.computerName, nodeId: id };
  return { name: computerName(node ?? {}), nodeId: id };
}

function siteOf(approval: BrowserApprovalRequest): string | null {
  const origins = approval.proposedGrant.allowedOrigins
    .map((origin) => `${origin.includeSubdomains ? '*.' : ''}${origin.hostPattern}${origin.port ? `:${origin.port}` : ''}`)
    .join(', ');
  return hostOf(approval.origin) ?? hostOf(approval.url) ?? (origins || null);
}

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return value;
  }
}

function rawScope(approval: BrowserApprovalRequest): string {
  const grant = approval.proposedGrant;
  const origins = grant.allowedOrigins
    .map((origin) => `${origin.scheme}://${origin.includeSubdomains ? '*.' : ''}${origin.hostPattern}${origin.port ? `:${origin.port}` : ''}`)
    .join(', ');
  return `${grant.mode} - ${grant.allowedActionClasses.join(', ')}${origins ? ` - ${origins}` : ''}`;
}

/**
 * Says where the element description came from. On a shared tab the gateway
 * cannot look at the page, so it is the agent's own hint; on a managed profile
 * it is read from the page itself.
 */
function elementSource(approval: BrowserApprovalRequest): string {
  return approval.profileId.startsWith('existing-tab:')
    ? 'Element (as the agent described it)'
    : 'Element (read from the page)';
}

function describeElement(element: BrowserElementContext | undefined): string | undefined {
  if (!element) return undefined;
  return [
    element.accessibleName,
    element.label,
    element.visibleText,
    element.role,
    element.inputType,
    element.inputName,
    element.placeholder,
    element.nearbyText,
  ].filter(Boolean).join(' - ') || undefined;
}

const MAX_LABEL_LENGTH = 60;

function elementLabel(element: BrowserElementContext | undefined): string | null {
  const raw = element?.accessibleName || element?.label || element?.visibleText || element?.placeholder;
  const text = raw?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return `'${text.length > MAX_LABEL_LENGTH ? `${text.slice(0, MAX_LABEL_LENGTH).trimEnd()}…` : text}'`;
}

function baseName(path: string | undefined): string | null {
  return path?.split(/[\\/]/).filter(Boolean).pop() ?? null;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function compact(entries: readonly (readonly [string, string | undefined])[]): BrowserApprovalFact[] {
  return entries.flatMap(([label, value]) => (value ? [{ label, value }] : []));
}
