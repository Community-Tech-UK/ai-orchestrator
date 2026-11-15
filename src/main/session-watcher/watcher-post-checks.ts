import type { WatcherBasis, WatcherStop, WatcherVerdict, WatcherVerdictKind } from './watcher-verdict';

/**
 * How much the user lets the watcher settle (the `keepSessionsGoing` setting, when it is on). Each level includes
 * the one before: nothing (it only tells the user); planned work; plus one clear recommendation or the user's own
 * earlier words; plus a next step the agent itself proposes.
 */
export const WATCHER_LEVELS = ['flag-only', 'planned-work', 'clear-choices', 'own-suggestions'] as const;
export type WatcherLevel = typeof WATCHER_LEVELS[number];

/** Matches the `watcher` limit in CONTINUATION_DISPATCH_POLICY. */
export const WATCHER_CHAIN_LIMIT = 10;
export const WATCHER_QUESTION_CHARS = 300;
const MIN_QUOTE_CHARS = 4;
const TAIL_CHARS = 1_500;

export type WatcherOverride =
  | 'inconsistent' | 'risk-last-sentence' | 'level' | 'quote-not-found' | 'quote-outward'
  | 'no-recommendation' | 'proposal-is-choice' | 'chain-limit' | 'no-progress';

export interface WatcherPostCheckContext {
  level: WatcherLevel;
  /** The agent's final reply in full. */
  finalReply: string;
  /** Every message the user typed in this session, in full. */
  personTexts: readonly string[];
  /** Automatic "carry on" replies already sent since the user's last message. */
  attempts: number;
  /** False when a watcher reply was sent and no tool has run since. */
  toolRanSinceWatcherReply: boolean;
}

export interface WatcherDecision {
  action: WatcherVerdictKind;
  stop: WatcherStop;
  basis: WatcherBasis;
  /** The user's own words, checked against what they typed; set only for `user_already_said`. */
  quote: string;
  /** The agent's own words from its final reply. Never the judge's wording. */
  question: string;
  /** Which code check changed the judge's verdict, if any. */
  override?: WatcherOverride;
  /** A fixed line shown to the user when the code, not the agent, is the reason they are needed. */
  note?: string;
}

const RECOMMENDATION = /\b(?:I(?:'d| would)? (?:recommend|suggest)|I(?:'d| would) go with|my (?:recommendation|suggestion)|recommended (?:option|approach|choice)|I lean towards?)\b/i;
const STOPS_NEEDING_USER = new Set<WatcherStop>(['asked_before_outward_step', 'waiting_for_user_action', 'asked_for_information']);
const STOPS_NOT_CARRIED = new Set<WatcherStop>(['work_complete', 'waiting_on_work']);
const LEVEL_RANK: Record<WatcherLevel, number> = { 'flag-only': 0, 'planned-work': 1, 'clear-choices': 2, 'own-suggestions': 3 };
/** The lowest level at which each kind of carry-on may be sent. */
const BASIS_LEVEL: Record<Exclude<WatcherBasis, 'none'>, WatcherLevel> = {
  planned_work: 'planned-work', own_recommendation: 'clear-choices', user_already_said: 'clear-choices', own_proposal: 'own-suggestions',
};

/** Whether the setting, as it stands now, still allows a carry-on of this kind. */
export function watcherLevelAllows(level: WatcherLevel | 'off', basis: WatcherBasis): boolean {
  return level !== 'off' && basis !== 'none' && LEVEL_RANK[BASIS_LEVEL[basis]] <= LEVEL_RANK[level];
}

/**
 * Steps that always stay with the user, whatever the level: anything that leaves their computers, cannot be undone,
 * costs money, touches a login, or restarts Harness itself. Run on one sentence or one short paragraph only.
 */
const OUTWARD_PATTERNS: readonly RegExp[] = [
  // Version control and release, in any form of the verb ("pushing", "committed", "the deployment").
  /\b(?:commit(?:s|ted|ting)?|push(?:es|ed|ing)?|pull request|merg(?:e|es|ed|ing) (?:it |this |that )?(?:in)?to main|deploy(?:s|ed|ing|ments?)?|releas(?:e|es|ed|ing)|publish(?:es|ed|ing)?|go(?:es|ing)? live|roll(?:s|ed|ing)? ?out|ship(?:s|ped|ping)? (?:it|this|that|them|to)\b)/i,
  /\b(?:prod|production|live (?:site|server|system|database|data)|staging|DNS|domain|app store|play store|testflight)\b/i,
  // Sending something to someone.
  /\b(?:send(?:s|ing)?|sent|post(?:s|ed|ing)?|repl(?:y|ies|ied|ying) to|e-?mail(?:s|ed|ing)?|notif(?:y|ies|ied|ying)|invit(?:e|es|ed|ing)|submit(?:s|ted|ting)?)\b.{0,60}\b(?:e-?mails?|messages?|repl(?:y|ies)|clients?|customers?|team|slack|discord|tickets?|issues?|comments?|forms?|reviews?)\b/i,
  /\b(?:creat(?:e|es|ed|ing)|open(?:s|ed|ing)?|fil(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|clos(?:e|es|ed|ing)|mov(?:e|es|ed|ing))\b.{0,40}\b(?:tickets?|issues?|linear|jira|calendar events?|invoices?)\b/i,
  // Deleting things.
  /\b(?:delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|drop(?:s|ped|ping)?|purg(?:e|es|ed|ing)|wip(?:e|es|ed|ing)|eras(?:e|es|ed|ing)|truncat(?:e|es|ed|ing)|discard(?:s|ed|ing)?|overwrit(?:e|es|ten|ing))\b.{0,60}\b(?:data|databases?|tables?|records?|rows|backups?|branch(?:es)?|history|accounts?|mailbox|e-?mails?|users?|logs?|folders?|director(?:y|ies)|files?)\b/i,
  /\b(?:rm -r|rm -rf|reset --hard|drop table|rewrite history)\b/i,
  // The same asks with a pronoun in place of the thing: "send it", "delete these", "roll it out", "check this in".
  /\b(?:send(?:s|ing)?|delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|wip(?:e|es|ed|ing)|publish(?:es|ed|ing)?)\s+(?:it|this|that|them|these|those)\b|\broll(?:s|ed|ing)?\s+\w+\s+out\b|\bcheck(?:s|ed|ing)?\s+(?:it|this|that|them|these)\s+in\b/i,
  /\b(?:clear(?:s|ed|ing)?|empt(?:y|ies|ied|ying)|reset(?:s|ting)?)\b.{0,30}\b(?:databases?|db|tables?|data|mailbox|inbox)\b/i,
  /\b(?:rotat|regenerat|revok)(?:e|es|ed|ing)\b.{0,30}\b(?:keys?|tokens?|access|credentials?|secrets?|certificates?)\b/i,
  /\bPRs?\b|\bmerg(?:e|es|ed|ing) (?:the |this |that |it |my |your )?(?:branch|in\b|into\b)|\btag(?:s|ged|ging)?\b.{0,20}\bv?\d|\binstall\b.{0,20}(?:-g\b|--global\b)/i,
  // Infrastructure and uploads.
  /\b(?:terraform|kubectl|helm|ansible)\b.{0,20}\b(?:apply|delete|destroy|install|upgrade)\b|\b(?:scp|rsync)\b|\bupload(?:s|ed|ing)?\b|\bsubmit(?:s|ted|ting)?\b.{0,30}\b(?:PRs?|pull requests?|app|build)\b/i,
  /\b(?:on|to|against) (?:the |a |our )?(?:live|remote|shared|prod\w*) (?:server|site|system|database|db|data)\b|\b(?:on|to|against) the server\b|\blive (?:db|database)\b/i,
  /\b(?:pay(?:s|ing)?|purchas(?:e|es|ed|ing)|buy(?:s|ing)?|subscrib(?:e|es|ed|ing)|upgrad(?:e|es|ed|ing) the plan|top(?:s|ped|ping)? up|add(?:s|ed|ing)? credits|billing|spend(?:s|ing)?|spent)\b|[$£€]\s?\d/i,
  /\b(?:passwords?|credentials?|secrets?|tokens?|api keys?|ssh keys?|two-factor|2fa|sign(?:ing)? in|log(?:ging)? in|accounts?)\b/i,
  /\b(?:restart(?:s|ed|ing)?|reboot(?:s|ed|ing)?|quit(?:s|ting)?|kill(?:s|ed|ing)?|stop(?:s|ped|ping)?|shut(?:s|ting)? down|clos(?:e|es|ed|ing)|relaunch(?:es|ed|ing)?|rebuild(?:s|ing)?|rebuilt|updat(?:e|es|ed|ing)|reinstall(?:s|ed|ing)?)\b.{0,40}\b(?:harness|ai orchestrator)\b/i,
];
/** "email Sam", "tell them": a named person or a pronoun straight after the verb. Case matters for the name. */
const TELLS_SOMEONE = /\b(?:[Ss]end(?:ing)?|[Ee]-?mail(?:ing)?|[Mm]essag(?:e|ing)|[Nn]otify(?:ing)?|[Tt]ell(?:ing)?|[Pp]ing(?:ing)?)\s+(?:[A-Z][a-z]+|him|her|them)\b|\b(?:[Ff]orward(?:ing)?|[Ss]har(?:e|ing)|[Cc]c)\b.{0,60}\b(?:to|with)\s+(?:[A-Z][a-z]+|him|her|them|the (?:client|customer|team))\b/;

/** True when the text names a step that must stay with the user. Input is bounded by the callers. */
export function namesOutwardStep(...texts: string[]): boolean {
  return texts.some((text) => {
    const bounded = text.slice(0, 2_000);
    return TELLS_SOMEONE.test(bounded) || OUTWARD_PATTERNS.some((pattern) => pattern.test(bounded));
  });
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The reply's last paragraph, cut to its final `maxChars`; what the user reads as the agent's question. */
export function closingParagraph(reply: string, maxChars = WATCHER_QUESTION_CHARS): string {
  const paragraphs = reply.trim().split(/\n[ \t]*\n/);
  const last = collapse(paragraphs[paragraphs.length - 1] ?? '');
  return last.length <= maxChars ? last : `...${last.slice(last.length - maxChars + 3)}`;
}

function tailSentences(reply: string): string[] {
  return reply.trim().slice(-TAIL_CHARS).split(/(?<=[.!?])[ \t]+|\n+/).map((piece) => piece.trim()).filter((piece) => /[A-Za-z0-9]/.test(piece));
}

/** The last sentence of the reply's tail. Bounded input, no nested quantifiers. */
export function lastSentence(reply: string): string {
  const sentences = tailSentences(reply);
  return sentences[sentences.length - 1] ?? '';
}

/**
 * The agent's closing ask: its last sentence, and the last question before it. A reply that ends "Shall I
 * commit and push? Let me know." asks about the push, not about letting anyone know.
 */
export function closingAsk(reply: string): string[] {
  const sentences = tailSentences(reply);
  const last = sentences[sentences.length - 1] ?? '';
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    if (sentences[index].includes('?')) return [last, sentences[index]];
  }
  return [last];
}

/** The judge's `question` is kept only when the agent really wrote it. */
function agentQuestion(verdictQuestion: string, finalReply: string): string {
  const wanted = collapse(verdictQuestion);
  if (wanted && wanted.length <= WATCHER_QUESTION_CHARS && collapse(finalReply).includes(wanted)) return wanted;
  return closingParagraph(finalReply);
}

function typedByUser(quote: string, personTexts: readonly string[]): boolean {
  const wanted = collapse(quote);
  return wanted.length >= MIN_QUOTE_CHARS && personTexts.some((text) => collapse(text).includes(wanted));
}

/**
 * Code checks the judge cannot override. They only ever make a verdict more
 * cautious: a `carry_on` may become `needs_user` or `finished`, never the reverse.
 */
export function applyWatcherPostChecks(verdict: WatcherVerdict, context: WatcherPostCheckContext): WatcherDecision {
  const question = agentQuestion(verdict.question, context.finalReply);
  const base: WatcherDecision = { action: verdict.verdict, stop: verdict.stop, basis: verdict.basis, quote: '', question };
  if (verdict.verdict !== 'carry_on') return { ...base, basis: 'none' };

  const toUser = (override: WatcherOverride, note?: string): WatcherDecision =>
    ({ ...base, action: 'needs_user', basis: 'none', override, ...(note ? { note } : {}) });

  if (STOPS_NOT_CARRIED.has(verdict.stop)) return { ...base, action: 'finished', basis: 'none', override: 'inconsistent' };
  if (verdict.basis === 'none' || STOPS_NEEDING_USER.has(verdict.stop)) return toUser('inconsistent');
  // An offer of extra work is only ever the agent's own proposal.
  if (verdict.stop === 'offered_extra_work' && verdict.basis !== 'own_proposal') {
    return { ...base, action: 'finished', basis: 'none', override: 'inconsistent' };
  }
  if (namesOutwardStep(...closingAsk(context.finalReply), question)) return toUser('risk-last-sentence');

  if (!watcherLevelAllows(context.level, verdict.basis)) return toUser('level');
  if (verdict.basis === 'user_already_said') {
    if (!typedByUser(verdict.quote, context.personTexts)) return toUser('quote-not-found');
    // The user's earlier words never settle an outward step; that answer has to be given now.
    if (namesOutwardStep(question, closingParagraph(context.finalReply, TAIL_CHARS), verdict.quote)) return toUser('quote-outward');
  }
  if (verdict.basis === 'own_recommendation' && !RECOMMENDATION.test(context.finalReply.slice(-TAIL_CHARS))) {
    return toUser('no-recommendation');
  }
  // A yes can only settle a yes-or-no proposal. A choice needs one stated recommendation instead.
  if (verdict.basis === 'own_proposal' && verdict.stop === 'offered_choice') return toUser('proposal-is-choice');

  if (context.attempts >= WATCHER_CHAIN_LIMIT) {
    return toUser('chain-limit', `Kept going ${WATCHER_CHAIN_LIMIT} times in a row. Check it is on track.`);
  }
  if (context.attempts > 0 && !context.toolRanSinceWatcherReply) {
    return toUser('no-progress', 'Stopped again without doing anything.');
  }
  return { ...base, quote: verdict.basis === 'user_already_said' ? collapse(verdict.quote) : '' };
}
