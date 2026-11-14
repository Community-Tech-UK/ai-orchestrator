import { removeQuotedAndTemplateContent } from './announce-then-halt-detector';

/** The question to quote back to the agent. */
export interface ContinueQuestionMatch {
  excerpt: string;
}

const MAX_QUESTION_LENGTH = 160;

// `\b` then a single separator run keeps repeated lead-ins linear ("so so so …?").
const LEAD_IN = String.raw`(?:(?:so|ok(?:ay)?|now|then|next|well|right|alright|from\s+here)\b[\s,—–-]*)*`;
const ASK_FRAME = String.raw`(?:(?:shall|should|can|may)\s+(?:i|we)|(?:do\s+you\s+)?want\s+me\s+to|would\s+you\s+like\s+me\s+to|(?:are\s+you\s+)?happy\s+for\s+me\s+to|(?:is\s+it\s+)?(?:ok(?:ay)?|alright|all\s+right|fine)\s+(?:for\s+me\s+)?to|(?:are\s+you\s+)?ready\s+(?:for\s+me\s+)?to)`;
const CARRY_ON = String.raw`(?:(?:start|begin|continue|keep|carry\s+on)\s+(?:implementing|coding|working)|continue|proceed|carry\s+on|keep\s+going|go\s+(?:ahead|on)|crack\s+on|press\s+on|move\s+(?:on|to)|resume|start|begin|get\s+started|implement|finish)`;
const STEP = String.raw`(?:(?:step|phase|stage|part|task|wave|item)s?\s+(?:\d+[a-z]?(?:\s*(?:[-–—]|to|and)\s*\d+[a-z]?)?|[a-z]|one|two|three|four|five|six|seven|eight|nine|ten))`;
const PLAN_OBJECT = String.raw`(?:(?:the|this|that|my|our)\s+)?(?:(?:next|remaining|rest\s+of\s+the)\s+)?(?:plan|implementation|work|steps?|phases?|tasks?|changes|fix(?:es)?|rest(?:\s+of\s+(?:the\s+)?(?:plan|steps|work))?|it|this|that|them|these|those)`;
/** A free word in a named part, never one that turns the question into a choice or a caveat ("or", "anyway", "without"). */
const FREE_WORD = String.raw`(?!(?:or|nor|but|anyway|instead|without|despite|regardless|even|unless|except|rather|than)\b)[\w-]+`;
/** "Continue with the handler", "move on to the API endpoints": a short noun phrase, never a new verb. */
const NAMED_PART = String.raw`(?:with|on\s+to|onto|to)\s+the\s+(?:${FREE_WORD}\s+){0,5}${FREE_WORD}`;
const TARGET = String.raw`(?:(?:(?:with|on|to|onto|into)\s+)?(?:${STEP}|${PLAN_OBJECT})|${NAMED_PART})`;
const TAIL = String.raw`(?:\s+(?:now|then|next|as\s+planned|from\s+here|here))?`;
const PERMISSION_QUESTION_RE = new RegExp(
  String.raw`^${LEAD_IN}(?:${ASK_FRAME}\s+(?:(?:now|next|then|just|first)\s+)?)?${CARRY_ON}(?:\s+and\s+${CARRY_ON})?(?:\s+${TARGET})?${TAIL}\s*\?$`,
  'i',
);

/** Options or a recommendation anywhere in the reply make "carry on" a choice the user hasn't made. */
const OPTIONS_OR_RECOMMENDATION_RE = new RegExp([
  String.raw`\boptions?\s+(?:[a-c1-3]|one|two|three)\b|\boptional(?:ly)?\b|\bchoice\b|\bwhat\s+i\s+can\s+do\b|\bonly\s+if\s+you\s+(?:want|like|need)\b`,
  String.raw`\b(?:two|three|four|several|a\s+few|some)\s+(?:(?:possible|different|other|main|viable|reasonable)\s+)?(?:options|alternatives|ways|approaches|ideas|paths|variants|routes|choices)\b`,
  String.raw`\b(?:two|three|four|several|a\s+few)\s+(?:possible|different|viable|alternative)\s+(?:fixes|solutions)\b|\beither\s+(?:works|is\s+fine|would\s+work|way)\b`,
  // Labels: "**Recommendation:** …", "Suggested approach: …".
  String.raw`^[ \t>*_#-]*(?:recommendation|suggestion|suggested\s+(?:approach|fix|option)|preferred\s+(?:option|approach))\b`,
  String.raw`\balternatives?\b|\balternatively\b|\banother\s+(?:approach|option|way)\b|\btrade-?offs?\b|\b(?:versus|vs\.?)\s`,
  String.raw`\b(?:i['’]d|i\s+would)\s+(?:go\s+for|pick|opt\s+for|rather)\b|\b(?:i['’]?d|i\s+would|we\s+should)\s+go\s+with\b|\blean(?:s|ing)?\s+towards?\b|\bthe\s+way\s+to\s+go\b`,
  String.raw`\bi(?:\s+would|['’]d)?\s+(?:suggest|recommend|prefer)\b|\bmy\s+(?:recommendation|suggestion|preference)\b|\brecommended\b`,
  String.raw`\b(?:looks|seems|feels)\s+(?:cleaner|better|simpler|safer|nicer|preferable)\b|\bi\s+think\b[^.?!]{0,60}\b(?:better|best)\b`,
  String.raw`\b(?:is\s+the\s+(?:better|best|safer|simpler|cleaner)|the\s+best)\s+(?:option|approach|choice|fit|way)\b`,
  String.raw`\b(?:simpler|safer|faster|cleaner|easier)\b[^.?!]{0,60}\bbut\b[^.?!]{0,60}\b(?:simpler|safer|faster|cleaner|easier)\b`,
  // "X or Y" offered by the agent: "I can … or …", "we could … or …", "either … or …".
  String.raw`\b(?:(?:i|we)\s+(?:can|could)(?!\s*n['’]?t|\s+not)|(?:we|you|i)\s+might|could\s+go\s+(?:in|into|on)|either)\b[^.?!]{0,80}\bor\b`,
  String.raw`^[ \t]*(?:[-*][ \t]*)?\**(?:option\s+[a-c1-3]|[a-c][).])\s|\ba\)\s[^\n]{0,160}\bb\)\s`,
  String.raw`\b(?:the|these|your|couple\s+of)\s+options\b|^[ \t]*\**options?\**\s*:|\bpros\b[^\n]{0,80}\bcons\b`,
  String.raw`\bi['’]d\s+(?:keep|use|stick|choose|pick|leave|avoid|switch|just)\b|\bmy\s+pick\b`,
].join('|'), 'im');
/** Named options whose labels are capitals or numbers ("Approach A", "Plan B"); case-sensitive so "plan a refactor" stays plain. */
const NAMED_OPTION_RE = /\b(?:[Aa]pproach|[Pp]lan|[Rr]oute|[Oo]ption)\s+(?:[A-C1-3]|[Oo]ne|[Tt]wo)\b|\b([A-Z][a-z]+)\s+A\b[\s\S]{0,400}?\b\1\s+B\b/;
/** A question that picks some of the offered items ("go ahead with the first two?") makes the choice itself. */
const SUBSET_QUESTION_RE = /\b(?:the\s+(?:first|last|other|top)\s+(?:one|two|three|four|\d+)|the\s+(?:second|third)(?:\s+one)?(?=\s*\?)|the\s+(?:former|latter)|the\s+(?!next\b|last\b|remaining\b|final\b)\w+\s+one\b|the\s+(?:first|second|third|other)\s+(?:approach|option|fix|way|version)\b|both|all\s+(?:\d+|two|three|four|five)|only\s+(?:some|one|the\s+first))\b/i;

/** A drafted message anywhere in the reply: after a draft, "go ahead" usually means "send it". */
const MESSAGE_DRAFT_RE = new RegExp([
  // Greeting lines: "Hi Lee,", "Hello everyone,", "Good morning Lee,", "Dear Mr Smith,", "Thanks Lee,".
  String.raw`^[ \t]*(?:>[ \t]*)?(?:[Hh]i|[Hh]iya|[Hh]ello|[Hh]ey|[Dd]ear|[Tt]hanks|(?:[Gg]ood )?(?:[Mm]orning|[Aa]fternoon|[Ee]vening)) (?:(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.? )?(?:[A-Z][\w-]*|all|team|everyone|both|folks|there)(?:[,!.]|[ \t]+[—–-][ \t]|[ \t]*$)`,
  // A name alone on a line ("Lee,"), as letters open.
  String.raw`^[ \t]*(?:>[ \t]*)?[A-Z][a-z]+,[ \t]*$`,
  // Sign-off lines.
  String.raw`^[ \t]*(?:>[ \t]*)?(?:[Tt]hanks|[Tt]hank you|[Mm]any thanks|[Bb]est|[Bb]est wishes|[Aa]ll the best|(?:[Bb]est |[Ww]arm |[Kk]ind )?[Rr]egards|[Cc]heers|[Ss]peak soon|[Yy]ours (?:sincerely|faithfully|truly))[,.!]?[ \t]*$`,
  String.raw`^[ \t]*\**(?:[Ss]ubject|To|Cc):|\b(?:[Dd]raft|[Mm]essage|[Ee]-?mail|[Rr]eply|[Ww]ording|[Cc]opy)\s+(?:is\s+)?below\b`,
  // A short line introducing a draft: "Draft email to Lee:", "Suggested wording:", "Proposed homepage copy:".
  String.raw`^[^\n]{0,80}\b(?:[Dd]raft|[Mm]essage|[Ee]-?mail|[Rr]eply|[Pp]ost|[Nn]ote|[Tt]ext|[Ss]end|[Ll]etter|[Ww]ording|[Cc]opy|[Bb]lurb|[Aa]nnouncement)\b[^\n]{0,40}:[ \t]*$`,
  // A short line naming who it is for: "Summary for Lee:", "I've written this for the team channel:".
  String.raw`^[^\n]{0,80}\b(?:for|to)\s+(?:[A-Z][a-z]+|the\s+(?:team|client|customers?|channel|group))\b[^\n]{0,30}:[ \t]*$`,
  String.raw`\b[Hh]ere(?:['’]s|\s+is)\s+(?:the|a|my)\s+(?:\w+\s+){0,2}(?:draft|message|email|e-mail|reply|response|text|note|post|letter)\b(?:\s+(?:for|to)\s+[\w-]+)?\s*:`,
  String.raw`\bwhat\s+[Ii](?:['’]d|\s+would)\s+(?:send|post|say|write)\b|\b[Pp]roposed\s+(?:reply|message|email|response|post|copy|wording|text|announcement)\b`,
].join('|'), 'm');

/** An open decision or offered extra work next to the question. */
const NEAR_DECISION_RE =
  /\bup\s+to\s+you\b|\byour\s+call\b|\bopen\s+questions?\b|\bwhether\b|\bnot\s+sure\b|\bunsure\b|\bunclear\b|\btbd\b|\b(?:pick|choose|decide)\s+between\b|\b(?:could|can)\s+also\b|\bwhile\s+i(?:['’]m|\s+am)\s+(?:at\s+it|here|in\s+there)\b/i;

/** The agent is waiting on something from the user. */
const WAITS_ON_USER_RE = new RegExp([
  String.raw`\b(?:once|until|unless)\s+you\b|\bwhen\s+you(?:['’]ve|['’]re|\s+(?:are|have|get|confirm|approve|reply))\b`,
  String.raw`\bif\s+you\s+(?:want|prefer|['’]d\s+like|would\s+like|agree|approve|confirm|can|could)\b`,
  String.raw`\byour\s+(?:approval|confirmation|go-ahead|answer|decision|input|reply|ok)\b`,
  String.raw`\bneeds?\s+(?:you|your)\b|\bfrom\s+you\b|\bwaiting\s+(?:for|on)\s+you\b|\byou(?:['’]ll|\s+will)?\s+need\s+to\b`,
  String.raw`\bbefore\s+i\s+(?:can\s+)?(?:continue|proceed|start)\b|\blet\s+me\s+know\b|\btell\s+me\b`,
  String.raw`\bcheck\s+with\s+you\b|\basked\s+me\s+to\s+(?:stop|wait|pause|check)\b|\bsaid\s+not\s+to\b|\bnot\s+to\s+make\s+(?:any\s+)?changes\b|\bonly\s+(?:to\s+)?plan\b|\bhold\s+off\b|\bnot\s+(?:to\s+)?implement\b`,
  String.raw`\bplease\s+(?:confirm|check|review|send|provide|share|tell|let|add|set)\b|\b(?:can|could)\s+you\s+confirm\b|\bconfirm\s+(?:that|whether|which|the)\b`,
  String.raw`\bneed\s+(?:the|an?|your)\s+(?:[\w-]+\s+){0,3}(?:token|key|password|credentials?|login|access|details|name|id|url)s?\b`,
].join('|'), 'i');

/**
 * Clear signs of a step that leaves this computer, can't be undone or costs
 * money. Checked against the raw text near the question, code included, so
 * `git push` in backticks still counts. Each word counts only in its risky
 * sense ("push to", not "push onto the list"; "delete the rows", not "the
 * delete button"), because ordinary progress notes use the same words; the
 * reply prompt covers anything this misses.
 */
const RISK_RE = new RegExp([
  // Messages and publishing.
  String.raw`\b(?:e-?mail(?:s|ed|ing)?(?!\s+(?:field|address|input|validation|validator|format|column|regex|template|parser))|send(?:ing)?(?!\s+(?:button|icon|handler|function|method|event|key|action|path))|sent\s+to|publish(?:ed|ing)?(?!\s+(?:step|event|method|function|handler|button))|tweet\w*|newsletters?)\b`,
  String.raw`\bdraft(?:ed|ing)?\s+(?:(?:a|an|the)\s+)?(?:email|message|reply|post|note|letter|response)\b|\b(?:the|my|a)\s+(?:draft|reply|response|message|post|email|announcement|newsletter)\s+(?:is|are)\s+(?:ready|written|drafted|done)\b`,
  String.raw`\b(?:repl(?:y|ies|ying)|respon(?:se|ses))\s+(?:to|on)\b|\breach(?:ing)?\s+out\b|\bfollow(?:ing)?\s+up\s+with\b|\bget(?:ting)?\s+back\s+to\b|\bwrite\s+to\b`,
  String.raw`\bhand\w*\s+(?:it\s+|this\s+|them\s+)?over\b|\bforward(?:ing)?\s+(?:it|this|that|them|the\s+(?:email|message|logs?|report|thread|docs?|document))\s+to\b`,
  String.raw`\b(?:post(?:s|ing)?\s+(?!requests?\b)(?:the\s+)?(?:[\w-]+\s+){0,2}|comment(?:s|ing)?\s+)(?:on|to|in)\b|\b(?:open|file|rais(?:e|ing))\s+(?:an?\s+)?(?:issues?|bugs?|tickets?|support\s+case)\b|\bsupport\s+(?:cases?|tickets?)\b`,
  String.raw`\binvite\s+(?!(?:dialog|modal|button|form|component|flow|page|screen|view)\b)\w+|\bmake\s+(?:\w+\s+){0,3}public\b|\b(?:ring|contact)\s+(?:the|him|her|them)\b|\brais(?:e|ing)\s+(?:it|this|that)\s+with\b|\bmessage\s+(?:the|everyone|all)\b`,
  String.raw`\blet\s+(?:the|my|our)\s+\w+\s+know\b|\btext\s+(?:[\w-]+\s+){1,3}to\b|\btell\s+the\s+(?:team|client|customer|users?|channel)\b`,
  // Shipping and other machines.
  String.raw`\b(?:deploy\w*|redeploy\w*|releas(?:e|es|ing)\s+(?:it|the|this|v?\d)|git\s+push|force[- ]push|merg(?:e|es|ing)\s+(?:it|the|this|to|into))\b|--force\b(?!\s+flag)`,
  String.raw`\bpush(?:es|ed|ing)?\b(?!\s+notifications?)(?![^.!?\n]{0,40}\b(?:onto|into)\b)|\bpull\s+requests?\b|\bupload\w*\s+(?:[\w-]+\s+){0,3}to\b|\bship\s+(?:it|this)\b`,
  String.raw`\bgo(?:es|ing)?\s+live\b|\bgo(?:es|ing)?\s+out\s+(?:to|on|today|tomorrow|now)\b|\bgo(?:es)?\s+to\s+the\s+(?:client|customer|team|users?)\b|\bready\s+to\s+(?:upload|send|publish|ship|release|go\s+out)\b`,
  String.raw`\b(?:production|prod)\b(?!\s+(?:build|bundle|mode|config))|\blive\s+(?:site|server|system|data(?:base)?)\b|\b(?:on|to)\s+the\s+(?:live\s+)?(?:website|site)\b`,
  String.raw`\b(?:on|to|onto)\s+(?:the\s+)?(?:server|vps|windows\s+pc|windows\s+box|test\s+mac|mac\s+mini|cluster|remote\s+machine)\b|\bstaging\s+(?:server|site|environment|env|database|db)\b|\b(?:to|on)\s+staging\b`,
  String.raw`\b(?:ssh|vps|ct-test-mac|terraform|kubectl|dns)\b|\broll(?:s|ing)?\s+(?:it\s+|this\s+|them\s+)?out\b|\bsubmit\w*\s+(?:it|this|that|them|the\s+(?:build|form|application|app))\b`,
  String.raw`\b(?:remote|origin)\s+branch\w*|\bbranches\s+from\s+the\s+remote\b|\brelease\s+script\b|\bnpm\s+run\s+release\b|\btag\s+v?\d|\bpublic\s+api\b|\bother\s+teams?\b|\bbreaking\s+changes?\b`,
  // Outside services.
  String.raw`\b(?:vercel|supabase|netlify|cloudflare|firebase|heroku|wordpress|wp-admin|elementor|woocommerce|shopify|mailchimp|cpanel|krystal|salesforce|hubspot|stripe|docusign|hmrc|bigquery|whatsapp|crm|slack|jira|app\s+store|testflight|s3)\b`,
  String.raw`\b(?:openai|anthropic|paid)\s+api\b|\bbatch\s+(?:job|run)s?\b|\bgpt-?\d[\w.]*|\bsign(?:s|ing)?\s+up\b|\bpaid\s+plan\b`,
  // Destructive or irreversible.
  String.raw`(?<!\.)\b(?:delet(?:e|es|ed|ing|ion|ions)\b(?![-\s]+(?:button|key|icon|handler|flag|column|dialog|action|method|function|endpoint))|truncat\w*|wip(?:e|es|ing)|purg(?:e|es|ing)|destroy\w*|eras(?:e|es|ing)|overwrit\w*|uninstall\w*)\b`,
  String.raw`\bdrop(?:s|ping)?\s+(?:the\s+)?(?:[\w-]+\s+){0,2}(?:table|database|db|column|schema|index)\b|\bremov\w*\s+(?:[\w-]+\s+){0,3}(?:records|rows)\b|\bdropdb\b|\brm\s+-\w+|\breset\s+--hard\b|\bgit\s+(?:clean|stash)\b`,
  String.raw`\bdiscard\w*\s+(?:the\s+)?(?:local\s+)?changes\b|\bformat\w*\s+(?:the\s+)?(?:disk|drive|volume|partition)\b|\bkill(?:all)?\s+(?:all|every|-9)\b|\bpkill\b`,
  String.raw`\bshut\w*\s*down\s+the\b|\b(?:restart|reboot)\w*\s+(?:the|my)\s+(?:pc|mac|computer|server|machine)\b|\birreversibl\w*|\bpermanently\s+(?:delet|remov|eras)\w*|\bcan(?:not|['’]?t)\s+be\s+(?:undone|reversed|recovered)\b`,
  String.raw`\b(?:remov|deactivat|disabl|suspend)\w*\s+(?:the\s+)?(?:[\w-]+\s+){0,2}(?:user\s+)?accounts?\b|\bbulk\s+update\b|\b\d{1,3}(?:,\d{3}){1,3}\s+(?:[\w-]+\s+)?(?:records|rows|users|customers|accounts|emails)\b|\b\d+k\s+(?:docs|documents|tickets|rows|records|emails|users|customers|products)\b`,
  // Security and accounts.
  String.raw`\b(?:grant\w*|revok\w*|rotat\w*)\s+(?:the\s+)?(?:[\w-]+\s+)?(?:access|rights|admin|permissions?|keys?|tokens?|credentials?)\b|\badmin\s+(?:rights|access|role|privileges)\b|\b(?:2fa|mfa|firewall)\b`,
  // Money and commitments.
  String.raw`\b(?:purchas\w*|buy(?:s|ing)?|refund\w*|invoic(?:e|es|ing)|spend(?:s|ing)?\s+(?:money|credits?|£|\$)|book(?:s|ing)?\s+(?:the|a)|order(?:s|ing)?\s+(?:the|a)|place\s+the\s+order)\b|[$£€]\s?\d{2,}`,
  String.raw`\bcharg(?:e|es|ing)\s+(?:the\s+)?(?:card|customer|client|account)\b|\bcancel\w*\s+(?:the\s+)?(?:[\w-]+\s+){0,2}(?:subscription|order|account|plan|booking|meeting)\b`,
  String.raw`\b(?:renew|upgrad)\w*\s+(?:the\s+)?(?:plan|subscription|tier|domain)\b|\btransfer\w*\s+(?:the\s+)?(?:funds|money|domain)\b|\b(?:tax\s+return|sign\w*\s+(?:the\s+)?(?:contract|agreement))\b`,
  String.raw`\bcalendar\s+(?:event|invite|entry)\b|\b(?:your|my)\s+calendar\b|\b(?:github|gitlab)\s+(?:issues?|discussions?|comments?|releases?)\b|\bfrom\s+(?:github|gitlab)\b|\bready\s+for\s+(?:release|launch|deploy\w*)\b`,
  String.raw`\b\d+(?:\.\d+)?\s*[mk]\s+tokens\b|\bmillions?\s+(?:of\s+)?tokens\b`,
  // "Subscribers" counts only after a messaging verb: "notifies all subscribers" is usually code.
  String.raw`\bnotif\w*\s+(?:all|every|the)\s+(?:[\w-]+\s+)?(?:users?|customers?|clients?|team)\b|\b(?:message|text|e-?mail)\s+(?:all|every(?:one)?|the)\s+(?:[\w-]+\s+){0,2}(?:users?|customers?|clients?|team|subscribers?|members?|list)\b`,
  String.raw`\bcosts?\s+(?:about\s+|around\s+|roughly\s+)?\d+\s+credits\b|\b(?:all|every)\s+\d{3,}\s+(?:[\w-]+\s+)?(?:records|rows|users|customers|accounts|emails)\b`,
  String.raw`\bcosts?\b[^.?!\n]{0,40}(?:[$£€]\s?\d|\d+\s*(?:dollars|pounds|euros))|[$£€]\s?\d+(?:\.\d+)?\s+(?:of|in|worth)\b|\b\d+\s*(?:dollars|pounds|euros|quid)\b`,
  String.raw`\breset\w*\s+(?:the\s+)?(?:[\w-]+\s+){0,2}(?:database|db|data)\b|\b(?:clear|remov|delet)\w*\s+(?:all|every)\s+(?:the\s+)?(?:saved|stored|user|customer|existing)\b`,
].join('|'), 'i');
/**
 * Case-sensitive signs: a person or service named in the step ("update Lee on
 * progress", "text Bob", "share the doc with Lee", "the Linear ticket"), a DNS
 * "A record" and a PR. Lowercase "update tests on CI" stays local.
 */
const CASE_SENSITIVE_RISK_RE = new RegExp([
  String.raw`\bLinear\b|\bLinkedIn\b|\bPRs?\b|\bA\s+records?\b(?!\s+of\b)`,
  String.raw`\bgo(?:es|ing)?\s+(?:out\s+)?to\s+(?:all\s+)?(?:[A-Z][a-z]+|customers|clients|users|everyone)\b`,
  String.raw`\b(?:[Uu]pdate|[Nn]otify|[Tt]ell(?:ing)?|[Tt]ext|[Pp]ing|[Mm]essage|DM|[Cc]ontact|[Cc]all|[Rr]ing|cc|[Ll]et|[Aa]sk)\s+[A-Z][a-z]+\b`,
  String.raw`\b[Ss]har(?:e|es|ing)\s+(?:the\s+|this\s+|it\s+)?(?:[\w-]+\s+)?with\s+(?:[A-Z][a-z]+|the\s+(?:team|client|customer|group)|everyone)\b`,
].join('|'));

/** Outward objects: the step itself is the user's call when it names one of these. */
const OUTWARD_OBJECTS = String.raw`commit\w*|upload(?:s|ed|ing)?|roll(?:out|back)s?|releas\w*|push\w*|merg\w*|reset\w*|send\w*|repl(?:y|ies)|tickets?|e-?mails?|invoic\w*|orders?|bookings?|payments?|customers?|clients?|prs?|pull\s+requests?|posts?|submi\w*|go-?live|launch\w*|sign-?ups?|purchas\w*|invit\w*|transfer\w*|payouts?|charg\w*|cancel\w*|renew\w*|shut-?down|tear-?down|cut-?over|hand-?over|hand-?off|outreach|texts|announcements?|broadcasts?|mail-?outs?|mailshots?`;
/**
 * Words that make the step a question names ("continue with the rollout?")
 * the user's call. Checked on the question only, where the object is the
 * next step itself, so this adds data-changing words to the outward objects.
 */
const QUESTION_OBJECT_RISK_RE = new RegExp(String.raw`\b(?:${OUTWARD_OBJECTS}|defaults?|migrat\w*|backfill\w*|clean-?up|remov\w*|(?:sync\w*|import\w*|export\w*|messages?|accounts?|users?|data(?:base)?)(?!\s+(?:settings|page|view|layer|screen|parser|logic|component|helper|list|table|panel|form|model|module|service|store|tab|dialog|modal|types?|paths?|statements?|handler|hook)\b))\b`, 'i');

const SUBJECT = String.raw`(?:i|we)`;
const WILL = String.raw`(?:['’]ll|\s+will)`;
/**
 * A next step the reply announces ("Next I'll …", "I'm going to …", "The plan
 * is to …", "Next: …"). Group 1 is the step. Plain "I'll …" is deliberately not
 * an announcement: "I'll leave the helper in place" is a note, not a next step.
 */
const ANNOUNCED_STEP_RE = new RegExp(String.raw`\b(?:${[
  String.raw`(?:next|then|now|after\s+that),?\s+${SUBJECT}${WILL}`,
  String.raw`${SUBJECT}${WILL}\s+(?:now|next|then)`,
  String.raw`${SUBJECT}(?:['’]m|['’]re|\s+am|\s+are)\s+going\s+to`,
  String.raw`${SUBJECT}\s+plan\s+to`,
  String.raw`(?:the|my|our)\s+plan\s+is\s+to`,
  String.raw`(?:my|our)\s+next\s+step\s+is(?:\s+to)?`,
  String.raw`(?:the\s+)?(?:next|remaining|last|final)\s+step\s+(?:is|will\s+be)(?:\s+to)?`,
  String.raw`next(?:\s+up)?\s*:`,
  String.raw`next\s+up\s+is`,
  String.raw`what(?:['’]s|\s+is)\s+left\s+is(?:\s+to)?`,
  String.raw`all\s+that(?:['’]s|\s+is)?\s+(?:left|remains)\s+is(?:\s+to)?`,
  String.raw`next\s+${SUBJECT}`,
].join('|')})\s+([^.!?\n]{1,160})`, 'gi');
/** "I'll update the client next": the step comes before the word "next". */
const TRAILING_NEXT_STEP_RE = new RegExp(String.raw`\b${SUBJECT}${WILL}\s+([^.!?\n]{1,120}?)\s+(?:next|after\s+that)\s*(?:[.!?\n]|$)`, 'gi');
/**
 * Ordinary local coding work. An announced next step must start with one of
 * these, or the reply is skipped: anywhere an agent names its next step, an
 * unknown verb is the user's call, so no outward wording needs predicting.
 */
const LOCAL_STEP_RE = new RegExp(String.raw`^(?:(?:also|then|now|first|go\s+ahead\s+and|start\s+(?:on|by))\s+)*(?:${[
  String.raw`implement\w*`, String.raw`add\w*`, String.raw`writ(?:e|es|ing)`, String.raw`fix\w*`, String.raw`refactor\w*`,
  String.raw`wir(?:e|es|ing)`, String.raw`renam\w*`, String.raw`extract\w*`, String.raw`mov(?:e|es|ing)`, String.raw`split\w*`,
  String.raw`updat(?:e|es|ing)`, String.raw`chang(?:e|es|ing)`, String.raw`remov(?:e|es|ing)`, String.raw`replac\w*`, String.raw`convert\w*`,
  String.raw`port\w*`, String.raw`inlin\w*`, String.raw`simplif\w*`, String.raw`tid(?:y|ies|ying)`, String.raw`clean(?:s|ing)?\s+up`,
  String.raw`document\w*`, String.raw`creat(?:e|es|ing)`, String.raw`build\w*`, String.raw`handl\w*`, String.raw`cover\w*`,
  String.raw`mak(?:e|es|ing)`, String.raw`tackl\w*`, String.raw`finish\w*`, String.raw`complet\w*`, String.raw`continu\w*`,
  String.raw`test\w*`, String.raw`typecheck\w*`, String.raw`lint\w*`, String.raw`verif\w*`, String.raw`check\w*`, String.raw`read\w*`,
  String.raw`look\s+at`, String.raw`investigat\w*`, String.raw`review\w*`, String.raw`debug\w*`, String.raw`trac(?:e|es|ing)`,
  String.raw`profil\w*`, String.raw`measur\w*`, String.raw`run(?:s|ning)?\s+(?:the\s+)?(?:[\w:-]+\s+){0,2}(?:tests?|specs?|typecheck|type\s+check|lint|linter|build|checks?|suite)`,
].join('|')})\b`, 'i');

/**
 * Who or what a local verb can still reach: "update the client", "add Lee to
 * the repo", "create the release", "change the password", "update the live config".
 */
const STEP_REACH_RE = new RegExp(String.raw`\b(?:${OUTWARD_OBJECTS}|team|everyone|website|(?<!call\s)site|live|password|access|installer|upstream|repo|archive|production|user\s+data|records|tag(?:s|ged|ging)?\s+(?:v?\d|the|it|a))\b`, 'i');
const STEP_PERSON_RE = /\b(?:with|to)\s+[A-Z][a-z]+\b|\b[A-Z][a-z]+\s+(?:to|about)\b/;

/** An announced next step that is not plainly local coding work, judged by its verb and by what it reaches. */
function hasNonLocalAnnouncedStep(context: string): boolean {
  const steps = [...context.matchAll(ANNOUNCED_STEP_RE), ...context.matchAll(TRAILING_NEXT_STEP_RE)]
    .map((match) => match[1].trim());
  return steps.some((step) => !LOCAL_STEP_RE.test(step)
    || STEP_REACH_RE.test(step)
    || STEP_PERSON_RE.test(step));
}

interface Block {
  text: string;
  kind: 'prose' | 'code' | 'structure';
}

/**
 * Splits raw reply text into blocks: fenced code is kept whole, and headings,
 * rules and list items are marked as structure so the context reaches past them.
 */
function splitBlocks(output: string): Block[] {
  const blocks: Block[] = [];
  let prose: string[] = [];
  let fence: string[] | null = null;
  const flushProse = () => {
    if (prose.length === 0) return;
    const text = prose.join('\n');
    const structural = prose.every((line) => /^\s*(?:#{1,6}\s|[-*_]{3,}\s*$|[-*+•]\s|\d+[.)]\s|>)/.test(line));
    blocks.push({ text, kind: structural ? 'structure' : 'prose' });
    prose = [];
  };
  for (const line of output.split('\n')) {
    const isFenceLine = /^\s*(?:```|~~~)/.test(line);
    if (fence) {
      fence.push(line);
      if (isFenceLine) {
        blocks.push({ text: fence.join('\n'), kind: 'code' });
        fence = null;
      }
    } else if (isFenceLine) {
      flushProse();
      fence = [line];
    } else if (line.trim()) {
      prose.push(line);
    } else {
      flushProse();
    }
  }
  if (fence) blocks.push({ text: fence.join('\n'), kind: 'code' });
  flushProse();
  return blocks;
}

/**
 * The raw text the question depends on: its own block, anything after it, and,
 * walking back, every code, list, heading and rule block up to and including
 * the first ordinary paragraph. A short paragraph that points back ("Run
 * this:") extends the walk to the next one.
 */
function rawQuestionContext(output: string): string {
  const blocks = splitBlocks(output);
  let index = blocks.length - 1;
  while (index > 0 && blocks[index].kind === 'code') index -= 1;
  let start = index;
  let paragraphsLeft = 1;
  while (start > 0 && paragraphsLeft > 0) {
    start -= 1;
    const block = blocks[start];
    if (block.kind !== 'prose') continue;
    const pointsBack = block.text.length < 100 && /\b(?:above|below|this|that|these|those|it)\b|:\s*$/i.test(block.text);
    if (!pointsBack) paragraphsLeft -= 1;
  }
  return blocks.slice(start).map((block) => block.text).join('\n');
}

/**
 * Lines elsewhere in the reply that describe the step the question names
 * ("step 2", "phase 3"): each matching line and the lines under it, up to the
 * next blank line. One pass, so long replies stay linear.
 */
function namedStepLines(output: string, question: string): string {
  const step = /\b(step|phase|stage|part|task|wave|item)\s+(\d+[a-z]?|[a-z]|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(question);
  if (!step) return '';
  const id = step[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = new RegExp(String.raw`\b${step[1]}\s+${id}\b|^\s*(?:#{1,6}\s*)?${id}[.):]\s`, 'i');
  const lines = output.split('\n');
  const picked: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!names.test(lines[index])) {
      index += 1;
      continue;
    }
    do {
      picked.push(lines[index]);
      index += 1;
    } while (index < lines.length && lines[index].trim());
  }
  return picked.join('\n');
}

/**
 * A two-item list followed by a question naming one of the items ("1. Patch
 * the adapter 2. Rewrite the parser … go ahead with the rewrite?") is a choice.
 */
function namesOneOfTwoListedItems(output: string, question: string): boolean {
  const named = /\b(?:with|to|onto)\s+the\s+([^?]+)\?$/i.exec(question)?.[1];
  if (!named) return false;
  const lines = output.split('\n');
  const items = lines.filter((line) => /^\s*(?:[-*+•]|\d+[.)])\s+\S/.test(line));
  // Bold labels ("**Quick fix:** …", "**Full fix:** …") offer options whatever their number.
  // Step and status labels ("**Step 2:**", "**Done:**") describe a plan, not options.
  const labels = lines.filter((line) => /^\s*(?:[-*+•]\s+)?\*\*(?!\s*(?:step|phase|stage|part|task|wave|done|next|status|progress|summary|result)\b)[^*\n]{1,40}:?\*\*/i.test(line));
  const offered = labels.length >= 2 ? labels : items.length === 2 ? items : [];
  const words = named.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return words.some((word) => offered.some((item) => item.toLowerCase().includes(word.replace(/(?:ing|e)$/, ''))));
}

/** Where the last sentence of a line starts, so a summary on the same line is not read as part of the question. */
function lastSentenceStart(line: string): number {
  const body = line.slice(0, -1);
  return Math.max(0, ...['. ', '! ', '? ', '; ', ': ', ' — ', ' – '].map((token) => {
    const index = body.lastIndexOf(token);
    return index < 0 ? 0 : index + token.length;
  }));
}

/** Text with quotes and code removed, emphasis marks dropped and space runs squashed. */
function tidy(stripped: string): string {
  return stripped.replace(/[*_~]+/g, '').replace(/[ \t]+/g, ' ').trim();
}

function cleanText(output: string): string {
  return tidy(removeQuotedAndTemplateContent(output));
}

/** Squashes runs of spaces and tabs, so patterns with `\s+` around a free-text group stay linear. */
function squashSpaces(text: string): string {
  return text.replace(/[^\S\n]+/g, ' ');
}

/** A list item or heading ending in "?" above the final line is a question still waiting for the user. */
const LISTED_QUESTION_RE = /^[ \t]*(?:[-*+•]|\d+[.)]|#{1,6})[ \t].*\?[ \t]*$/;

/**
 * Detects a reply that ends by asking permission to keep doing work the agent
 * already planned ("Shall I implement?", "Shall I proceed with phase 2?"). Such
 * a turn stops a session for nothing, so regular sessions get an automatic,
 * conditional "carry on" (see buildContinueQuestionReply).
 *
 * Two layers keep that reply away from decisions the user should make:
 * - The final sentence must be on an allow-list of plain "carry on" questions.
 * - The reply is skipped when the text makes the next step clearly the user's
 *   call: options or a recommendation, a drafted message, another question or
 *   request to the user, an open decision, offered extra work, or a clear sign
 *   of a step that leaves this computer, can't be undone or costs money.
 * The second layer is a word list and can't name every outward step, so the
 * reply itself also tells the agent to stop and ask before any such step.
 * Ordinary coding words are deliberately left out of the list: every one that
 * appears near most progress summaries would make the feature useless.
 */
export function detectTrailingContinueQuestion(output: string): ContinueQuestionMatch | null {
  // Cleaning never adds a question mark, so most turns stop here without the costlier work below.
  if (!output.includes('?')) return null;
  const stripped = removeQuotedAndTemplateContent(output);
  const text = tidy(stripped);
  if (!text.endsWith('?')) return null;

  // Dashes split sentences only when spaced (" — "), so "steps 3–5" stays whole.
  const body = text.slice(0, -1);
  const start = Math.max(0, ...['.', '!', '?', ';', ':', '\n', ' — ', ' – '].map((token) => {
    const index = body.lastIndexOf(token);
    return index < 0 ? 0 : index + token.length;
  }));
  const question = text.slice(start).replace(/^\s*(?:[-•>]|\d+[.)])?\s*/, '').trim();
  if (!question || question.length > MAX_QUESTION_LENGTH || !PERMISSION_QUESTION_RE.test(question)) return null;
  // The raw last line keeps quoted words ("the “user import” step") that cleaning removed, but only
  // counts when it is the same sentence: an indented code line is not the question.
  const rawLastLine = output.trimEnd().split('\n').pop()?.replace(/[*_~]+/g, '').trim() ?? '';
  const rawQuestion = rawLastLine.slice(lastSentenceStart(rawLastLine)).replace(/^\s*(?:[-•>]|\d+[.)])?\s*/, '');
  const sameSentence = rawQuestion.endsWith('?') && rawQuestion.length <= MAX_QUESTION_LENGTH * 2
    && cleanText(rawQuestion) === question;
  const asked = sameSentence ? rawQuestion : question;
  if (
    QUESTION_OBJECT_RISK_RE.test(question) || QUESTION_OBJECT_RISK_RE.test(asked)
    || SUBSET_QUESTION_RE.test(question) || SUBSET_QUESTION_RE.test(asked)
    || namesOneOfTwoListedItems(output, question)
  ) {
    return null;
  }

  if (OPTIONS_OR_RECOMMENDATION_RE.test(text) || NAMED_OPTION_RE.test(text) || MESSAGE_DRAFT_RE.test(output)) return null;
  const strippedLines = stripped.trimEnd().split('\n');
  if (strippedLines.slice(0, -1).some((line) => LISTED_QUESTION_RE.test(line))) return null;
  const nearby = rawQuestionContext(output);
  // Any other question near this one is waiting on the user, and the reply would answer it too.
  // Counted before squashing spaces, which would turn indented code into prose.
  if ((removeQuotedAndTemplateContent(nearby).match(/\?/g) ?? []).length > 1) return null;
  const context = squashSpaces(`${nearby}\n${namedStepLines(output, question)}`);
  if (
    NEAR_DECISION_RE.test(context)
    || WAITS_ON_USER_RE.test(context)
    || RISK_RE.test(context)
    || CASE_SENSITIVE_RISK_RE.test(context)
    || hasNonLocalAnnouncedStep(context)
  ) {
    return null;
  }
  return { excerpt: asked };
}
