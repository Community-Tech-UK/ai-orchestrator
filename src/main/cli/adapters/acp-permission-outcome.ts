import type { AcpPermissionOption, AcpSessionRequestPermissionOutcome } from '../../../shared/types/cli.types';

const slug = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Explicit option ids are authoritative. For prose, a refusal or a question must never become a
// grant just because it mentions "allow". Generic assent requires a complete affirmative reply.
const REFUSAL_WORD = /^(?:no|n|nope|never|deny|denies|denied|reject|rejects|rejected|decline|declines|declined|refuse|refused|stop|abort|pass|skip|cancel|cancelled|canceled|not|do not|don t|dont)\b/;
const REFUSAL_PHRASE = /\b(?:do not|don t|dont|never|cannot|can t|cant|will not|won t|wont|stop|abort|pass|skip|cancel|cancelled|canceled)\b|\bnot (?:allow|approve|grant|accept)\w*\b|\b(?:deny|denies|denied|reject|rejects|rejected|decline|declines|declined|refuse|refused)\b/;
const REFUSAL_VERB = /\b(?:deny|denies|denied|denying|reject(?:s|ed|ing)?|declin(?:e|es|ed|ing)|refus(?:e|es|ed|ing)|disallow(?:s|ed|ing)?|disapprov(?:e|es|ed|ing)|forbid(?:s|den|ding)?|forbade|prohibit(?:s|ed|ing)?|withhold(?:s|ing)?|withheld|refrain(?:s|ed|ing)?|abstain(?:s|ed|ing)?|veto(?:es|ed|ing)?)\b/;
const ASSENT_REPLY = /^(?:yes|y|yeah|yep|ok|okay|sure|fine|sounds good)(?: please)?(?: (?:go ahead|do it|proceed))?(?: (?:(?:just|only) )?(?:once|always|forever))?(?: thanks)?$/;
const ASSENT_ACTION = /^(?:(?:yes|y|yeah|yep|ok|okay|sure|fine) )?(?:please )?(?:i (?:always )?(?:allow|approve|grant|accept)|(?:always )?(?:allow|allowed|approve|approved|grant|granted|accept|accepted|proceed|go ahead|do it))(?: (?:it|this|that))?(?: (?:once|always|forever))?(?: (?:but )?(?:just|only) once)?(?: please)?$/;
// Asking about the request is not consent. The raw reply is checked for "?" because slug() drops it.
const QUESTION_MARK = /[?]/;
// Interrogative clauses can follow assent. A conditional "when tests pass" is still a scope.
const QUESTION_FORM = /^(?:what|why|how|which|who|where|is|are|does|did|can|could|would|should|explain|tell me|describe)\b|\b(?:can|could|would|should|may|must|shall|will|do|does|did|is|are|was|were|has|have) (?:i|we|you|it|this|that|they|the|there)\b/;
const NON_CONSENT_PHRASE = /\b(?:explain|clarify|describe|tell me|not sure|not certain|uncertain|unsure|undecided|not decided|maybe|perhaps|i don t know|depends|unable|unwilling|incapable|unprepared|unready|reluctant|hesitant|opposed|against|disinclined|hold off|hold on)\b/;
const NEGATION = /^(?:no|not|never|cannot|(?:do|does|did|ca|wo|sha|shall|will|would|should|could|is|are|am|was|were|have|has|had|must|need|dare|ai|may|might|ought|used)nt)$/;
const PERMISSION_ACTION = /^(?:allow|approv(?:e|ing)|grant|accept|consent|agree|authori[sz](?:e|ing)|permit)\w*$/;
const NO_DECISION = /\b(?:answer|response|decision) (?:is|was|would be) no\b/;
const LIMITED_DURATION = /\b(?:just|only) (?:this|one) (?:time|request|call)\b|\b(?:one|single|this) time\b|\bthis (?:request|call) only\b/;
const GENERIC_ASSENT = /^(?:yes|y|yeah|yep|ok|okay|sure|fine|allow|approve|grant|accept|proceed|go ahead|do it)$/;
const GENERIC_REFUSAL = /^(?:no|n|nope|never|deny|reject|decline|refuse|stop|abort|pass|skip|cancel|not)$/;
const ONCE_HINT = /\bonce\b/;
const ALWAYS_HINT = /\b(?:always|forever|remember|remembered|permanent|permanently|persistently)\b/;

function negatesPermission(label: string): boolean {
  let negated = false;
  // Intent words can separate a negation from its action: "don't want to allow".
  for (const word of label.replace(/\b([a-z]+n) t\b/g, '$1t').split(' ')) {
    if (NEGATION.test(word)) negated = true;
    if (negated && PERMISSION_ACTION.test(word)) return true;
  }
  return NO_DECISION.test(label);
}

function permissionChoiceClauses(response: string): string[] {
  const clauses = response.split(/[,;:.!\r\n]/)
    .map(value => slug(value).replace(/^please /, '').replace(/ please$/, ''))
    .filter(Boolean);
  return clauses.flatMap(clause => {
    // The agent defines an offered condition; assess the decision outside that condition.
    if (/^(?:if|when|unless|after|provided)\b/.test(clause)) {
      if (/^when (?:can|could|would|should|may|must|shall|will|do|does|did|is|are|was|were|has|have)\b/.test(clause)) return [clause];
      return clauses.length > 1 ? [] : [clause];
    }
    const condition = clause.search(/\b(?:if|when|unless|after|provided)\b/);
    const decision = condition < 0 ? clause : clause.slice(0, condition).trim();
    return decision ? [decision] : [];
  });
}

export function selectAcpPermissionOutcome(options: AcpPermissionOption[], response: string): AcpSessionRequestPermissionOutcome {
  if (!response.trim()) return { outcome: 'cancelled' };
  const exact = options.find(option => option.optionId === response);
  if (exact) return { outcome: 'selected', optionId: exact.optionId };
  const normalized = slug(response);
  if (!normalized || normalized === 'cancel') return { outcome: 'cancelled' };
  const allow = options.find(option => option.kind === 'allow_once') ?? options.find(option => option.kind.startsWith('allow'));
  const reject = options.find(option => option.kind === 'reject_once') ?? options.find(option => option.kind.startsWith('reject'));
  const allowAlways = options.find(option => option.kind === 'allow_always');
  const rejectAlways = options.find(option => option.kind === 'reject_always');
  const selected = (option: AcpPermissionOption | undefined): AcpSessionRequestPermissionOutcome => option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
  // Generic assent/refusal never chooses an always option while a once choice exists; an explicit
  // "always" (and no "once") in the reply is the only wording that prefers the lasting option.
  const wantsAlways = ALWAYS_HINT.test(normalized) && !ONCE_HINT.test(normalized);
  const allowChoice = wantsAlways ? allowAlways ?? allow : allow;
  const rejectChoice = wantsAlways ? rejectAlways ?? reject : reject;
  if (QUESTION_MARK.test(response)) return selected(reject);
  const labelText = normalized.replace(/^please /, '').replace(/ please$/, '');
  const exactLabels = options.filter(option => option.name === response.trim());
  const labels = exactLabels.length ? exactLabels : options.filter(option => slug(option.name) === labelText);
  if (labels.length > 1) return selected(reject);
  const matchedLabel = labels[0];
  if (matchedLabel && !GENERIC_ASSENT.test(labelText) && !GENERIC_REFUSAL.test(labelText)) {
    // A unique offered choice keeps the agent-defined scope; never invent a scope from prose.
    // Questions/refusals are not consent, and one-call wording conflicts with remembered approval.
    const clauses = permissionChoiceClauses(response);
    const decision = clauses.join(' ');
    if (matchedLabel.kind.startsWith('allow') && (REFUSAL_WORD.test(decision) || REFUSAL_VERB.test(decision)
      || negatesPermission(decision) || NON_CONSENT_PHRASE.test(decision)
      || clauses.some(clause => QUESTION_FORM.test(clause.replace(/^(?:yes|y|yeah|yep|ok|okay|sure|fine) /, '')))
      || (matchedLabel.kind === 'allow_always' && (ONCE_HINT.test(decision) || LIMITED_DURATION.test(decision))))) {
      return selected(reject);
    }
    return selected(matchedLabel);
  }
  if (QUESTION_FORM.test(normalized) || NON_CONSENT_PHRASE.test(normalized)) return selected(reject);
  if (REFUSAL_WORD.test(normalized) || REFUSAL_PHRASE.test(normalized)) return selected(rejectChoice);
  // A generic "allow" uses the once option even when a lasting option is labelled "Allow".
  if (ASSENT_REPLY.test(normalized) || ASSENT_ACTION.test(normalized)) return selected(allowChoice);
  return selected(reject);
}
