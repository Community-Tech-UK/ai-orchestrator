import { removeQuotedAndTemplateContent } from './announce-then-halt-detector';

const TRAILING_CHARACTERS = 400;
const SENTENCES_CHECKED = 3;
const MAX_EXCERPT_CHARACTERS = 160;
const WILL = String.raw`\bI(?:['’]ll|\s+will)\s+(?:then\s+)?`;
const ACTS = String.raw`(?:pick\s+(?:(?:this|it|that)\s+)?(?:back\s+)?up|continue|carry\s+on|resume|finish|report|come\s+back|check|retry|try\s+again|start|download|review|test|verify|let\s+you\s+know|update\s+you|tell\s+you|get\s+back\s+to\s+you)\b`;
const ONCE = String.raw`\b(?:when|once|after|as\s+soon\s+as)\b`;
/** Where a clause can open, past any list or bold marker. */
const CLAUSE_START = String.raw`(?:^|[,;:]\s*|\b(?:and|so|but|then)\s+)[-*•\s]*`;
const WAITING_RES = [
  /\bI(?:['’]m|\s+am)\s+(?:(?:now|still|just)\s+)*waiting\s+(?:for|on|until)\b/i,
  /^(?:(?:now|still|just)\s+)*waiting\s+(?:for|on|until)\b/i,
  new RegExp(String.raw`${WILL}${ACTS}[^.!?]{0,90}${ONCE}`, 'i'),
  // The same promise with the condition first: "When it's finished I'll download the result" (24 November 2026). Not
  // "after that", which only orders the agent's own steps, nor a condition on the agent or the person ("when we...").
  new RegExp(String.raw`${CLAUSE_START}(?!after\s+(?:that|this|which),?\s+I\b)${ONCE}(?!\s+(?:I|we)\b)[^.!?]{0,90}?${WILL}${ACTS}`, 'i'),
];
/**
 * A closing line that needs the person's answer or action: a question, an approval request or a step for them. Any
 * plan before it waits on them, so a check-in must never nudge past it ("...I'll start the migration. Please confirm.").
 */
const ASKS_THE_PERSON = String.raw`\?|^\W*(?:please|could\s+you|can\s+you)\b`;
/** A sentence that hands the person a step, so a wait right after it ("Once that's done, I'll...") is theirs. */
const ASKS_THE_PERSON_RE = new RegExp(String.raw`${ASKS_THE_PERSON}|^\W*(?:just\s+)?(?:restart|relaunch|reload|click|press|approve|merge|publish|sign\s+in|log\s+in|install|accept|grant|enable|upload|reply|run\s+(?:the|this|that|it))\b(?!\s+(?:is|was|went|worked|finished|completed?|done|succeeded|failed)\b)`, 'i');
const NEEDS_THE_PERSON_RE = new RegExp(String.raw`${ASKS_THE_PERSON}|\b(?:please\s+confirm|let\s+me\s+know\s+if\s+(?:you(?:['’]d|\s+would)?\s+(?:like|want)\s+me\s+to|that(?:['’]s|\s+is)\s+(?:ok|okay|fine|alright|all\s+right))|let\s+me\s+know\s+(?:which|whether|what|how)|^\W*(?:just\s+)?confirm|(?:once|after|when)\s+you\s+(?:approve|confirm|decide|agree|sign\s+off|give)|your\s+(?:go-?ahead|approval|sign-?off|decision)|if\s+that\s+works|(?:your\s+call|up\s+to\s+you|over\s+to\s+you)|say\s+the\s+word|reply\s+(?:yes|no))\b`, 'i');
/** A promise about future habits after a correction ("Next time, I'll test it after each change") waits on nothing. */
const HABIT_RE = /\b(?:next\s+time|from\s+now\s+on|in\s+(?:the\s+)?future|going\s+forward|lessons?\s+learned)\b/i;
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
const WAITING_ON_A_PERSON_RE = /\b(?:you|your|yours|james|the\s+user|he|she|him|her|approv(?:al|e|ed|es)|sign-?off|go-?ahead|confirm(?:ation|ed)|agreed|accepted|ok(?:a)?yed|decided|signed[\s-]?in)\b/i;
/** An instruction to the person opening a clause: "Once it's done, let me know and I'll finish". */
const ASKING_A_PERSON_RE = /(?:^|[,;:]\s*|\b(?:and|so|but|then|just|please)\s+)(?:let\s+me\s+know|tell\s+me|send\s+me|ask\s+me|ping\s+me|remind\s+me|give\s+me)\b/i;
/** Saying who will hear the result ("I'll let you know when...") is not waiting on that person. */
const REPORTING_TO_A_PERSON_RE = /\bI(?:['’]ll|\s+will)\s+(?:then\s+)?(?:let\s+(?:you|james|the\s+user)\s+know|(?:tell|update|get\s+back\s+to|report\s+(?:back\s+)?to)\s+(?:you|james|the\s+user))\b/gi;
/** Offering to do it sooner ("so ask me whenever you'd like that done") is not waiting on them either. Ends at its clause. */
const OFFERING_TO_A_PERSON_RE = /\b(?:ask(?:\s+me)?|ping\s+me|remind\s+me|tell\s+me|let\s+me\s+know)\s+(?:whenever|when|if)\s+you(?:['’]d|\s+would)?\s+(?:like|want|prefer|need)\b(?:(?!\b(?:and|but|or)\b)[^,;.!?])*/gi;

/** The sentence where a reply ends by waiting on work, not on a person, or null. */
export function detectWaitingOnWork(output: string): string | null {
  const normalized = removeQuotedAndTemplateContent(output).replace(/\s+/g, ' ').trim();
  const sentences = normalized.slice(-TRAILING_CHARACTERS).split(/(?<=[.!?])\s+/);
  for (let index = sentences.length - 1; index >= Math.max(0, sentences.length - SENTENCES_CHECKED); index -= 1) {
    const sentence = sentences[index];
    if (NEEDS_THE_PERSON_RE.test(sentence)) return null;
    const aboutThePerson = sentence.replace(REPORTING_TO_A_PERSON_RE, '').replace(OFFERING_TO_A_PERSON_RE, '');
    if (WAITING_ON_A_PERSON_RE.test(aboutThePerson) || ASKING_A_PERSON_RE.test(aboutThePerson) || HABIT_RE.test(sentence)) continue;
    const heldByBusyComputer = BUSY_COMPUTER_RES.some((pattern) => pattern.test(sentence)) && WORK_HELD_RE.test(sentence);
    if (!heldByBusyComputer && !WAITING_RES.some((pattern) => pattern.test(sentence))) continue;
    // "Please restart the app. Once that's done, I'll check the logs." waits on the step asked for just before.
    return index > 0 && ASKS_THE_PERSON_RE.test(sentences[index - 1]) ? null : sentence.slice(0, MAX_EXCERPT_CHARACTERS);
  }
  return null;
}
