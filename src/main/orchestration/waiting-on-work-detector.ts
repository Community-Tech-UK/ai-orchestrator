import { removeQuotedAndTemplateContent } from './announce-then-halt-detector';

const TRAILING_CHARACTERS = 400;
const SENTENCES_CHECKED = 3;
const MAX_EXCERPT_CHARACTERS = 160;
const WAITING_RES = [
  /\bI(?:['’]m|\s+am)\s+(?:(?:now|still|just)\s+)*waiting\s+(?:for|on|until)\b/i,
  /^(?:(?:now|still|just)\s+)*waiting\s+(?:for|on|until)\b/i,
  /\bI(?:['’]ll|\s+will)\s+(?:then\s+)?(?:pick\s+(?:(?:this|it|that)\s+)?(?:back\s+)?up|continue|carry\s+on|resume|finish|report|come\s+back|check|retry|try\s+again|start|let\s+you\s+know|update\s+you|tell\s+you|get\s+back\s+to\s+you)\b[^.!?]{0,90}\b(?:when|once|after|as\s+soon\s+as)\b/i,
];
// Work held up by a busy computer: nothing reports when it frees up (14 November 2026, "the test Mac is overloaded, so
// no test app is running there"). Both halves must be in one sentence, so a summary saying the work went elsewhere
// passes. Present tense only, and not after "if" or "whenever", which is advice about some later time.
const NOT_CONDITIONAL = String.raw`(?<!\b(?:if|when|whenever|unless|until|once)\s+(?:\S+\s+){0,4})`;
const COMPUTER = String.raw`\b(?:mac|pc|machines?|computers?|hosts?)(?:['’]s)?`;
const BUSY_COMPUTER_RES = [
  new RegExp(String.raw`${NOT_CONDITIONAL}${COMPUTER}\b[^.!?]{0,60}?\b(?:is|are|remains|stays)\s+(?:(?:still|currently|now|too|very|so|all|both)\s+)*`
    + String.raw`(?:overloaded|busy|saturated|at\s+capacity|(?:too|heavily)\s+loaded|under\s+(?:a\s+)?(?:heavy|high)\s+load)\b`, 'i'),
  new RegExp(String.raw`${NOT_CONDITIONAL}${COMPUTER}\s+load\s+(?:is|remains|stays)\s+(?:(?:still|currently|now|far|much|very)\s+)*too\s+high\b`, 'i'),
];
const WORK_HELD_RE = /\b(?:held|holding|on\s+hold|hold(?:ing)?\s+off|skipp(?:ed|ing)|nothing\s+is\s+running|wait(?:s|ing)?|paused|parked|blocked|deferred|postponed|not\s+(?:running|started|starting|launch(?:ed|ing)|run|up)|(?:did\s+not|didn['’]t|won['’]t|will\s+not)\s+(?:start|run|launch)|too\s+(?:busy|loaded)\s+to|(?:ha(?:ve|s)\s+not|ha(?:ve|s)n['’]t)\s+(?:started|run)|pending|isn['’]t\s+(?:running|up)|no\s+(?:\S+\s+){0,3}running|can(?:not|['’]t)\s+(?:run|start|launch|go\s+ahead))\b/i;
const WAITING_ON_A_PERSON_RE = /\b(?:you|your|yours|james|the\s+user|he|she|him|her|approv(?:al|e|ed|es)|sign-?off|go-?ahead|confirmation)\b/i;
/** Saying who will hear the result ("I'll let you know when...") is not waiting on that person. */
const REPORTING_TO_A_PERSON_RE = /\bI(?:['’]ll|\s+will)\s+(?:then\s+)?(?:let\s+(?:you|james|the\s+user)\s+know|(?:tell|update|get\s+back\s+to|report\s+(?:back\s+)?to)\s+(?:you|james|the\s+user))\b/gi;

/** The sentence where a reply ends by waiting on work, not on a person, or null. */
export function detectWaitingOnWork(output: string): string | null {
  const normalized = removeQuotedAndTemplateContent(output).replace(/\s+/g, ' ').trim();
  const sentences = normalized.slice(-TRAILING_CHARACTERS).split(/(?<=[.!?])\s+/).slice(-SENTENCES_CHECKED);
  for (const sentence of sentences.reverse()) {
    if (WAITING_ON_A_PERSON_RE.test(sentence.replace(REPORTING_TO_A_PERSON_RE, ''))) continue;
    const heldByBusyComputer = BUSY_COMPUTER_RES.some((pattern) => pattern.test(sentence)) && WORK_HELD_RE.test(sentence);
    if (heldByBusyComputer || WAITING_RES.some((pattern) => pattern.test(sentence))) return sentence.slice(0, MAX_EXCERPT_CHARACTERS);
  }
  return null;
}
