import { removeQuotedAndTemplateContent } from './announce-then-halt-detector';

const TRAILING_CHARACTERS = 400;
const SENTENCES_CHECKED = 3;
const MAX_EXCERPT_CHARACTERS = 160;
const WAITING_RES = [
  /\bI(?:['’]m|\s+am)\s+(?:(?:now|still|just)\s+)*waiting\s+(?:for|on|until)\b/i,
  /^(?:(?:now|still|just)\s+)*waiting\s+(?:for|on|until)\b/i,
  /\bI(?:['’]ll|\s+will)\s+(?:then\s+)?(?:pick\s+(?:(?:this|it|that)\s+)?(?:back\s+)?up|continue|carry\s+on|resume|finish|report|come\s+back|check|let\s+you\s+know|update\s+you|tell\s+you|get\s+back\s+to\s+you)\b[^.!?]{0,90}\b(?:when|once|after|as\s+soon\s+as)\b/i,
];
const WAITING_ON_A_PERSON_RE = /\b(?:you|your|yours|james|the\s+user|approv(?:al|e|ed|es)|sign-?off|go-?ahead|confirmation)\b/i;
/** Saying who will hear the result ("I'll let you know when...") is not waiting on that person. */
const REPORTING_TO_A_PERSON_RE = /\bI(?:['’]ll|\s+will)\s+(?:let\s+(?:you|james|the\s+user)\s+know|(?:tell|update|get\s+back\s+to|report\s+(?:back\s+)?to)\s+(?:you|james|the\s+user))\b/gi;

/** The sentence where a reply ends by waiting on work, not on a person, or null. */
export function detectWaitingOnWork(output: string): string | null {
  const normalized = removeQuotedAndTemplateContent(output).replace(/\s+/g, ' ').trim();
  const sentences = normalized.slice(-TRAILING_CHARACTERS).split(/(?<=[.!?])\s+/).slice(-SENTENCES_CHECKED);
  for (const sentence of sentences.reverse()) {
    if (WAITING_ON_A_PERSON_RE.test(sentence.replace(REPORTING_TO_A_PERSON_RE, ''))) continue;
    if (WAITING_RES.some((pattern) => pattern.test(sentence))) return sentence.slice(0, MAX_EXCERPT_CHARACTERS);
  }
  return null;
}
