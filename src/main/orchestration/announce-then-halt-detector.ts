const ACTION_VERBS =
  '(?:run|re-?run|execute|test|verify|check|inspect|review|read|open|edit|update|write|create|add|apply|fix|implement|refactor|change|remove|debug|investigate|build|typecheck|lint)';
const FIRST_PERSON_FUTURE_SOURCE = String.raw`i(?:['’]ll|\s+will|(?:\s+am|['’]m)\s+going\s+to|\s+need\s+to)`;
const FUTURE_INTENT_SOURCE = String.raw`\b(?:${FIRST_PERSON_FUTURE_SOURCE}|next\s*,?\s+${FIRST_PERSON_FUTURE_SOURCE})\b`;
const BROAD_FUTURE_ACTION_SOURCE =
  String.raw`${FUTURE_INTENT_SOURCE}(?!\s+not\b).{0,140}\b${ACTION_VERBS}\b`;
const IMMEDIATE_FUTURE_ACTION_SOURCE =
  String.raw`${FUTURE_INTENT_SOURCE}\s+(?!not\b)(?:(?:now|next|then|immediately|first|finally|quickly|directly|also)\s+)?(?:(?:proceed\s+to|go\s+ahead\s+and)\s+)?\b${ACTION_VERBS}\b`;
const USER_DEPENDENT_ACTION_RE = new RegExp(
  String.raw`\b(?:as\s+soon\s+as|subject\s+to|if|when|once|after|until|unless|provided|assuming|with|without|on)\b.{0,140}\b(?:you|your|user|operator|approval|approve(?:d)?|confirmation|confirm(?:ed)?|permission|input|decision|command|go-ahead|green\s+light)\b|\b(?:pending|awaiting|waiting\s+for|requires?|needs?|cannot\s+proceed|can(?:not|'t)\s+proceed|unable\s+to\s+proceed)\b.{0,100}\b(?:you|your|user|operator|approval|confirmation|permission|input|decision|command|go-ahead|green\s+light)\b`,
  'i',
);
const REGULAR_SESSION_TRAILING_CHARACTERS = 600;
const USER_DEPENDENCY_CONTEXT_BEFORE_ACTION = 180;
const MAX_TRAILING_TEXT_AFTER_PROMISE = 160;
const PROVIDER_LIMIT_DEPENDENCY_RE =
  /\b(?:rate[-\s]+limit(?:ed)?|(?:five[-\s]+hour|weekly|daily)\s+limit|usage\s+window|session\s+limit|provider\s+limit|token\s+limit|(?:provider\s+)?capacity|quota|allowance|credits?)\b/i;
const RESOLVED_PROVIDER_LIMIT_RE =
  /(?:\b(?:rate[-\s]+limit|usage\s+window|provider\s+limit|capacity|quota|allowance)\b.{0,60}\b(?:clear(?:ed)?|lifted|reset|refreshed|restored|available)|\b(?:restored|available|refreshed)\b.{0,30}\b(?:provider\s+)?capacity\b)/i;
const EXAMPLE_OR_TEMPLATE_CONTEXT_RE =
  /\b(?:for\s+example|e\.g\.|wording|phrase|template|example|you\s+could\s+say|to\s+avoid\s+is)\b/i;
const REPORTED_OR_HYPOTHETICAL_CONTEXT_RE =
  /(?:\b(?:if|whether|in\s+the\s+event\s+that|on\s+the\s+condition\s+that)\b|^\s*(?:suppose|assume|assuming|imagine|pretend|maybe|perhaps|possibly|apparently|seemingly|presumably|hypothetically|in\s+case)\b|^\s*it\s+(?:appears|seems|follows)\s+(?:that\s+)?|\b(?:hypothetical|counterfactual|in\s+theory|theoretically|for\s+illustration)\b|\b(?:according\s+to|per)\s+(?:the\s+)?(?:assistant|agent|model|transcript|response|reply|output|message|text)\b|\b(?:assistant|agent|model|transcript|conversation|log|response|reply|output|message|text|documentation|prompt)\b.{0,100}\b(?:say|says|said|reply|replies|replied|report|reports|reported|record|records|recorded|show|shows|showed|depict|depicts|depicted|write|writes|wrote|read|reads|state|states|stated|claim|claims|claimed|mean|means|meant)\s*(?:that|[:,])?\s*$|\b(?:told|asked|instructed|quoted|paraphrased)\s+(?:the\s+)?(?:user|operator|you|them|him|her)\s*(?:that|:)?\s*$|\bavoid(?:\s+the)?\s+(?:sentence|phrase|wording|saying|writing)\b|\b(?:sentence|prompt|template|wording|phrase|transcript|reply|response|output|message|text|reported\s+(?:answer|response))\s*:\s*$|\b(?:say|says|said|saying|reply|replies|replied|report|reports|reported|think|thinks|thought|believe|believes|believed|expect|expects|expected|mean|means|meant|imply|implies|implied|write|writes|wrote|writing|read|reads|state|states|stated|include|includes|included|contain|contains|contained|use|uses|used)\s*(?:that|:)?\s*$)/i;
const META_ATTRIBUTION_CONTEXT_RE =
  /(?:\b(?:exact\s+)?words?\s+(?:were|are|was|is)\s*$|\b(?:status\s+line|required\s+line|instruction|reply|response|answer|message|text|prompt|output|implication)\s+(?:is|was|should\s+be)\s*:?\s*$|^\s*(?:do|did|would|could|can)\s+(?:you|we|they)\s+(?:think|believe|expect|suppose)\b)/i;
const PREVIOUS_SENTENCE_META_NOUN_SOURCE =
  '(?:assistant|agent|model|llm|bot|reviewer|transcript|reply|response|answer|template|example|scenario|sample|hypothetical|illustration|demonstration|illustrative|wording|phrase|sentence|line|status(?:\\s+(?:line|update))?|update|report|documentation|prompt|message|text|output|draft|runbook|block|quotation|quoted|chat|tutorial|guide|log|copy|training|snippet|synthetic|close|material|exercise|stanza|prose|specimen|verbatim|tool|statement|imported|workshop|literal)';
const PREVIOUS_SENTENCE_REPORTING_VERB_SOURCE =
  '(?:follows?|reads?|says?|said|states?|stated|writes?|wrote|shows?|showed|records?|recorded|contains?|contained|includes?|included|copies?|copied|quotes?|quoted|transcribes?|transcribed|paraphrases?|paraphrased|starts?|started|attributes?|attributed|captures?|captured|comes?|came|ends?|ended|closes?|closed|recalls?|recalled|demonstrates?|demonstrated|generates?|generated|prints?|printed|borrows?|borrowed|concludes?|concluded)';
const PREVIOUS_SENTENCE_FRAMING_RE =
  new RegExp(
    String.raw`(?:\b${PREVIOUS_SENTENCE_META_NOUN_SOURCE}\b.{0,100}\b(?:${PREVIOUS_SENTENCE_REPORTING_VERB_SOURCE}|below|next)\b|\b${PREVIOUS_SENTENCE_REPORTING_VERB_SOURCE}\s*$|(?:^|[.!?;]\s*)(?:use|consider|imagine|suppose|assume)\b.{0,100}\b(?:template|example|scenario|wording|phrase|reply|response|text|following|this)\b|(?:^|[.!?;]\s*)(?:(?:this|that|it)\s+(?:is|was)\s+(?:an?\s+)?(?:example|template|scenario|sample|hypothetical)|the\s+following\s+(?:is|are)\b.{0,100}\b${PREVIOUS_SENTENCE_META_NOUN_SOURCE}|to\s+illustrate|for\s+illustration|for\s+example|for\s+instance|as\s+an\s+example|hypothetically)\b|(?:^|[.!?;]\s*)(?:here|below)\s+(?:is|are)\b.{0,100}\b${PREVIOUS_SENTENCE_META_NOUN_SOURCE}\b)`,
    'i',
  );
const RECENT_EXPLICIT_META_FRAMING_RE = new RegExp(
  String.raw`(?:\b${PREVIOUS_SENTENCE_META_NOUN_SOURCE}\b.{0,100}\b${PREVIOUS_SENTENCE_REPORTING_VERB_SOURCE}\b|\b${PREVIOUS_SENTENCE_REPORTING_VERB_SOURCE}\b.{0,100}\b${PREVIOUS_SENTENCE_META_NOUN_SOURCE}\b|\b${PREVIOUS_SENTENCE_META_NOUN_SOURCE}\b[^.!?;]{0,100}:\s*(?:[.!?]\s*)?|\b(?:in|for)\s+(?:this|that|the\s+following)\s+(?:example|scenario|sample)\b|\b(?:for\s+example|for\s+instance|as\s+an\s+example|to\s+illustrate)\b|(?:^|[.!?;]\s*)(?:(?:this|that|it)\s+(?:is|was)|(?:this|that|the)\s+${PREVIOUS_SENTENCE_META_NOUN_SOURCE}\s+(?:is|was))\s+(?:an?\s+)?(?:example|template|scenario|sample|hypothetical)\b|(?:^|[.!?;]\s*)the\s+following\s+(?:is|are)\b.{0,100}\b${PREVIOUS_SENTENCE_META_NOUN_SOURCE}\b|\b${PREVIOUS_SENTENCE_META_NOUN_SOURCE}\b.{0,100}\b(?:appears?|is|comes?)\s+(?:below|next)\b|\b(?:use|copy|paste|quote|paraphrase|transcribe)\b.{0,120}\b(?:line|reply|response|output|text|wording)\b|(?:^|[.!?;]\s*)(?:here|below)\s+(?:is|are)\b.{0,100}\b${PREVIOUS_SENTENCE_META_NOUN_SOURCE}\b)`,
  'i',
);
const RECENT_STANDALONE_META_HEADING_RE = new RegExp(
  String.raw`(?:^|[.!?;]\s*)(?:(?:suggested|possible|sample|copyable|training|synthetic|quoted|archived)\s+)?${PREVIOUS_SENTENCE_META_NOUN_SOURCE}(?:\s+${PREVIOUS_SENTENCE_META_NOUN_SOURCE}){0,2}\s*:?\s*(?:[.!?]\s*)?$`,
  'i',
);
const RECENT_EXPLICIT_META_MARKER_RE =
  /\b(?:please\s+avoid\s+(?:this\s+)?commitment|do\s+not\s+(?:repeat\s+(?:this\s+)?promise|output\s+the\s+following)|ignore\s+the\s+next\s+line|these\s+are\s+not\s+my\s+words|(?:documentation|assistant|agent|model|transcript|reply|response)\s+reports?|illustrative\s+material|prose\s+specimen|quoted\s+material|verbatim\s+material|closing\s+(?:line|statement|promise))\b/i;
const RECENT_UNCERTAINTY_RE =
  /(?:^|[.!?;]\s*)(?:maybe|perhaps|possibly|hopefully)\s*[.!?;]?\s*$/i;
const ALTERNATIVE_AFTER_ACTION_RE =
  /\bor\s+(?:wait|defer|pause|stop|skip)\b/i;
const UNCERTAIN_TAG_AFTER_ACTION_RE =
  /,\s*(?:right|correct|okay|ok|yes|maybe|probably|hopefully|i\s+(?:suppose|guess)|don['’]t\s+you\s+think|or\s+(?:perhaps|maybe)\s+not|or\s+will\s+i|(?:should|would|could|will|won['’]t|shall|shan['’]t|can|can['’]t)\s+i(?:\s+not)?)\s*[.!?]?\s*$/i;
const DIRECT_INTENT_TRANSITION_RE =
  /^(?:[-*•](?:\s*\[[ xX]\])?|okay|ok|alright|all\s+right|now|next|next\s+(?:step|action)|then|finally|lastly|first|second|so|therefore|accordingly|after\s+that|that\s+said|moving\s+on|having\s+done\s+that|here['’]s\s+what\s+i['’]ll\s+do\s+next|now\s+that\s+(?:that(?:['’]s|\s+is)|it(?:['’]s|\s+is))\s+done|one\s+(?:more|final|last)\s+(?:thing|step)|with\s+that(?:\s+(?:done|settled|resolved|complete|finished|addressed|out\s+of\s+the\s+way))?|at\s+this\s+point|in\s+that\s+case)\s*[,;:—–-]?\s*$/i;
const DIRECT_INTENT_AFTER_CLAUSE_RE =
  /(?:,\s*(?:so|therefore|then|next|now|finally)\s*$|^(?:(?:(?:the\s+)?(?:patch|fix|change|implementation)\s+is\s+(?:in|ready|complete|done)|.{0,120}\b(?:complete|completed|ready|done|fixed|updated|implemented|resolved|finished))\s*,?\s+and|(?:even\s+though|although|despite|because|since|given(?:\s+that)?|after\s+that|now\s+that|after\s+(?:checking|reviewing|correcting|fixing|updating|implementing|verifying|testing|running|reading|inspecting)|for\s+(?:safety|certainty|completeness)|to\s+be\s+(?:safe|sure|certain)|before\s+(?:i|we)\s+(?:finish|stop|wrap\s+up))\b.{0,140},)\s*$)/i;
const DEFERRED_ACTION_RE =
  /\b(?:later|tomorrow|tonight|someday|eventually|before\s+long|in\s+(?:due\s+course|a\s+while|the\s+next\s+release|(?:half\s+an?|\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|a\s+few)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?))|as\s+time\s+permits|at\s+some\s+point|if|unless|provided|assuming|subject\s+to|when(?:ever)?|after|once|until|as\s+soon\s+as|pending|upon|during|following|over\s+the\s+weekend|this\s+(?:morning|afternoon|evening|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in\s+the\s+(?:morning|afternoon|evening)|next\s+(?:week|month|quarter|year|release|day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s+[a-z]+)|at\s+(?:dawn|close\s+of\s+business|noon|midnight|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+o['’]clock|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?))\b/i;
const BENIGN_TRAILING_EXPLANATION_RE =
  /^(?:this\s+should\s+take\s+(?:under|about|less\s+than)?\s*(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|few|\d+)?\s*(?:moment|minutes?|hours?)|(?:it|this)\s+should\s+(?:only\s+)?take\s+(?:a\s+)?(?:moment|minutes?|few\s+minutes)|(?:the\s+step|this)\s+is\s+(?:a\s+)?read-only(?:\s+check)?|no\s+user\s+input\s+is\s+required|i\s+expect\s+a\s+quick\s+answer|it\s+may\s+take\s+(?:a\s+)?(?:moment|minute|few\s+minutes))\.?$/i;
const COMPLETED_ACTION_EVIDENCE_RE =
  /\b(?:pass(?:ed|ing)|fail(?:ed|ing|ures?)|complete(?:d)?|finished|succeed(?:ed|ing)?|success(?:ful(?:ly)?)?|done|found|confirmed|verified|inspected|ran|executed|updated|fixed|implemented|built|checked|tested|generated|exists?|present|returned|offline|unavailable|disconnected|missing|read-only|not\s+installed|cannot\s+be\s+reached|exit\s+status\s+\d+|got\s+http\s+\d+|green|clean|zero\s+failures?|no\s+failures?|results?\s+(?:show|shows|are|were))\b/i;
const COMPLETION_CLAUSE_BOUNDARY_RE =
  /(?:[.!?;:]|\s*[-—–]\s*|,\s*(?:(?:and|but|which|with|so)\s+)?|[([]\s*(?:which\s+)?|\b(?:and|but|so|because|although|though|yet)\s+)/i;

function hasCompletionEvidenceAfterActionClause(
  tail: string,
  match: AnnounceThenHaltMatch,
): boolean {
  const afterActionVerb = tail.slice(match.intentEnd);
  const boundary = COMPLETION_CLAUSE_BOUNDARY_RE.exec(afterActionVerb);
  if (!boundary) return false;
  return COMPLETED_ACTION_EVIDENCE_RE.test(
    afterActionVerb.slice(boundary.index + boundary[0].length),
  );
}

function isDirectIntentPrefix(prefix: string): boolean {
  const trimmed = prefix.replace(/\*{2}|_{1,2}|~{1,2}/g, '').trim();
  return !trimmed
    || DIRECT_INTENT_TRANSITION_RE.test(trimmed)
    || DIRECT_INTENT_AFTER_CLAUSE_RE.test(trimmed);
}

function readPreviousSentences(precedingText: string, currentBoundary: number): string {
  if (currentBoundary < 0) return '';
  let contextStart = currentBoundary;
  for (let sentence = 0; sentence < 2; sentence++) {
    const earlierText = precedingText.slice(0, contextStart);
    contextStart = Math.max(
      earlierText.lastIndexOf('.'),
      earlierText.lastIndexOf('!'),
      earlierText.lastIndexOf('?'),
      earlierText.lastIndexOf(';'),
    );
    if (contextStart < 0) break;
  }
  return precedingText.slice(contextStart + 1, currentBoundary).trim();
}

export interface AnnounceThenHaltMatch {
  excerpt: string;
  start: number;
  intentEnd: number;
  end: number;
}

function toActionMatch(
  normalized: string,
  match: RegExpExecArray,
): AnnounceThenHaltMatch {
  const nextBoundaryCandidates = ['.', '!', '?']
    .map((token) => normalized.indexOf(token, match.index + match[0].length))
    .filter((index) => index >= 0);
  const nextBoundary = nextBoundaryCandidates.length > 0 ? Math.min(...nextBoundaryCandidates) : normalized.length;
  const start = match.index;
  const end = nextBoundary < normalized.length ? nextBoundary + 1 : normalized.length;
  return {
    excerpt: normalized.slice(start, end).trim().slice(0, 180),
    start,
    intentEnd: match.index + match[0].length,
    end,
  };
}

function detectAllAnnounceThenHalt(
  output: string,
  pattern: string,
): AnnounceThenHaltMatch[] {
  const normalized = output.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const matcher = new RegExp(pattern, 'ig');
  const matches: AnnounceThenHaltMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(normalized)) !== null) {
    matches.push(toActionMatch(normalized, match));
  }
  return matches;
}

export function detectAnnounceThenHalt(output: string): AnnounceThenHaltMatch | null {
  return detectAllAnnounceThenHalt(output, BROAD_FUTURE_ACTION_SOURCE)[0] ?? null;
}

function removeQuotedAndTemplateContent(output: string): string {
  let cleaned = output
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/^[ \t]*[\w.-]+\s*:\s*[|>][-+]?\s*\n(?:[ \t]+.*(?:\n|$))+/gm, ' ')
    .replace(/<(blockquote|pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const unmatchedFence = Math.max(cleaned.lastIndexOf('```'), cleaned.lastIndexOf('~~~'));
  if (unmatchedFence >= 0) cleaned = cleaned.slice(0, unmatchedFence);

  const unmatchedHtmlContainer = /<(?:blockquote|pre|code)\b[^>]*>/i.exec(cleaned);
  if (unmatchedHtmlContainer) cleaned = cleaned.slice(0, unmatchedHtmlContainer.index);

  cleaned = cleaned
    .split('\n')
    .map((line) => (/^\s*>|^(?: {4}|\t)/.test(line) ? '' : line))
    .join('\n');

  cleaned = cleaned
    .replace(/`[^`\n]{0,400}`/g, ' ')
    .replace(/“[^”\n]{0,400}”/g, ' ')
    .replace(/"[^"\n]{0,400}"/g, ' ')
    .replace(/‘[^’\n]{0,400}’/g, ' ');

  for (const unmatchedOpening of ['`', '“', '"', '‘']) {
    const index = cleaned.indexOf(unmatchedOpening);
    if (index >= 0) cleaned = cleaned.slice(0, index);
  }

  const characters = [...cleaned];
  let singleQuoteStart = -1;
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== "'") continue;
    const previous = characters[index - 1] ?? '';
    const next = characters[index + 1] ?? '';
    if (/\p{L}|\p{N}/u.test(previous) && /\p{L}|\p{N}/u.test(next)) continue;
    if (
      singleQuoteStart < 0
      && /\p{L}|\p{N}/u.test(previous)
      && (!next || /[\s.,;:!?]/.test(next))
    ) {
      continue;
    }
    if (singleQuoteStart < 0) {
      singleQuoteStart = index;
      continue;
    }
    for (let replaceIndex = singleQuoteStart; replaceIndex <= index; replaceIndex += 1) {
      if (characters[replaceIndex] !== '\n') characters[replaceIndex] = ' ';
    }
    singleQuoteStart = -1;
  }
  if (singleQuoteStart >= 0) {
    characters.splice(singleQuoteStart);
  }
  return characters.join('');
}

/**
 * High-confidence variant for human-facing regular sessions. The promise must
 * be near the end of the reply and must not explicitly depend on user input or
 * approval. Loop Mode deliberately keeps using the broader detector because it
 * also has stage/tool/change evidence with which to reject false positives.
 */
export function detectTrailingAnnounceThenHalt(output: string): AnnounceThenHaltMatch | null {
  const normalized = removeQuotedAndTemplateContent(output)
    .replace(/\n+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  const tail = normalized.slice(-REGULAR_SESSION_TRAILING_CHARACTERS);
  const tailOffset = normalized.length - tail.length;
  const matches = detectAllAnnounceThenHalt(tail, IMMEDIATE_FUTURE_ACTION_SOURCE);
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    const dependencyContext = tail.slice(
      Math.max(0, match.start - USER_DEPENDENCY_CONTEXT_BEFORE_ACTION),
    );
    const precedingText = normalized.slice(0, match.start + tailOffset);
    const recentContextBeforeAction = tail.slice(0, match.start);
    const previousSentenceBoundary = Math.max(
      precedingText.lastIndexOf('.'),
      precedingText.lastIndexOf('!'),
      precedingText.lastIndexOf('?'),
      precedingText.lastIndexOf(';'),
    );
    const currentClauseBeforeAction = precedingText.slice(previousSentenceBoundary + 1);
    const previousSentences = readPreviousSentences(precedingText, previousSentenceBoundary);
    const directIntentPrefix = isDirectIntentPrefix(currentClauseBeforeAction);
    const immediateAfterActionPrefix = DIRECT_INTENT_AFTER_CLAUSE_RE.test(
      currentClauseBeforeAction.trim(),
    );
    const hasDeferredActionContext = DEFERRED_ACTION_RE.test(dependencyContext);
    const hasDeferredTimingAfterIntent = DEFERRED_ACTION_RE.test(
      tail.slice(match.intentEnd, match.end),
    );
    const hasUnresolvedProviderLimit = PROVIDER_LIMIT_DEPENDENCY_RE.test(dependencyContext)
      && !RESOLVED_PROVIDER_LIMIT_RE.test(dependencyContext);
    if (
      USER_DEPENDENT_ACTION_RE.test(dependencyContext)
      || hasUnresolvedProviderLimit
      || hasDeferredTimingAfterIntent
      || (hasDeferredActionContext && !immediateAfterActionPrefix)
      || EXAMPLE_OR_TEMPLATE_CONTEXT_RE.test(currentClauseBeforeAction)
      || REPORTED_OR_HYPOTHETICAL_CONTEXT_RE.test(currentClauseBeforeAction)
      || META_ATTRIBUTION_CONTEXT_RE.test(currentClauseBeforeAction)
      || PREVIOUS_SENTENCE_FRAMING_RE.test(previousSentences)
      || RECENT_EXPLICIT_META_FRAMING_RE.test(recentContextBeforeAction)
      || RECENT_STANDALONE_META_HEADING_RE.test(recentContextBeforeAction)
      || RECENT_EXPLICIT_META_MARKER_RE.test(recentContextBeforeAction)
      || RECENT_UNCERTAINTY_RE.test(recentContextBeforeAction)
      || !directIntentPrefix
    ) {
      continue;
    }

    const textAfterPromise = tail.slice(match.end).trim();
    const describesEarlierWork = /^(?:the\s+)?(?:previous|earlier|first)\b/i.test(
      textAfterPromise,
    );
    const hasBenignTrailingExplanation = BENIGN_TRAILING_EXPLANATION_RE.test(textAfterPromise);
    if (
      (textAfterPromise.length > 0 && !describesEarlierWork && !hasBenignTrailingExplanation)
      || textAfterPromise.length > MAX_TRAILING_TEXT_AFTER_PROMISE
      || textAfterPromise.includes('?')
      || match.excerpt.includes('?')
      || UNCERTAIN_TAG_AFTER_ACTION_RE.test(match.excerpt)
      || ALTERNATIVE_AFTER_ACTION_RE.test(tail.slice(match.intentEnd, match.end))
      || (!describesEarlierWork
        && !hasBenignTrailingExplanation
        && hasCompletionEvidenceAfterActionClause(tail, match))
    ) {
      continue;
    }

    return {
      excerpt: match.excerpt,
      start: match.start + tailOffset,
      intentEnd: match.intentEnd + tailOffset,
      end: match.end + tailOffset,
    };
  }
  return null;
}
