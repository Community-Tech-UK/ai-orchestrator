import type { OutputMessage } from '../../../../shared/types/instance.types';
import { presentError, type PresentedError } from '../../../../shared/present-error';
import type { CodexDiagnostic } from './exec-diagnostics';

/** Codex lines can be long; Details keeps enough to diagnose, not a whole log. */
const MAX_DETAIL_CHARS = 4000;
/** One entry per message object: a retry of the same message is the same turn, a new message is a new turn. */
const shownByTurn = new WeakMap<object, Set<string>>();

/**
 * One line per category per turn. A fatal line is judged separately from a harmless one of the
 * same category, so an early warning cannot hide the line that explains why the turn failed.
 */
export function claimCodexDiagnosticSlot(turn: object, diagnostic: Pick<CodexDiagnostic, 'category' | 'fatal'>): boolean {
  let shown = shownByTurn.get(turn);
  if (!shown) {
    shown = new Set<string>();
    shownByTurn.set(turn, shown);
  }
  const key = `${diagnostic.category}:${diagnostic.fatal ? 'fatal' : 'note'}`;
  if (shown.has(key)) return false;
  shown.add(key);
  return true;
}

const QUIET_WARNING = {
  headline: 'Codex logged a warning while working.',
  whatToDo: 'No action needed: your message and the work above are kept.',
};
/**
 * Worded so the existing session-not-found handling still recognises the message
 * (instance-communication blacklists the dead session from an error's text).
 */
const LOST_SESSION_HEADLINE = 'That Codex session does not exist any more.';

/** The sentence for a Codex log line. Only closed vocabulary and a tool server's name reach it. */
export function presentCodexDiagnostic(diagnostic: CodexDiagnostic): PresentedError {
  const evidence = { message: diagnostic.line.slice(0, MAX_DETAIL_CHARS) };
  const context = { provider: 'codex' };
  switch (diagnostic.category) {
    case 'auth':
    case 'network':
      return presentError({ code: diagnostic.category, ...evidence }, context);
    case 'tool-server':
      return presentError({ code: 'tool-server', ...evidence }, { ...context, ...(diagnostic.toolServer ? { toolServer: diagnostic.toolServer } : {}) });
    case 'session':
      return { ...presentError({ code: 'unknown', ...evidence }, context), headline: LOST_SESSION_HEADLINE };
    default:
      return diagnostic.fatal
        ? presentError({ code: 'unknown', ...evidence }, context)
        : { category: 'unknown', ...QUIET_WARNING, rawDetail: evidence.message };
  }
}

/** The transcript message for a Codex log line: a plain sentence, with the line itself behind Details. */
export function codexDiagnosticOutput(diagnostic: CodexDiagnostic): Pick<OutputMessage, 'type' | 'content' | 'metadata'> {
  const presented = presentCodexDiagnostic(diagnostic);
  return {
    type: diagnostic.fatal ? 'error' : 'system',
    content: `${presented.headline} ${presented.whatToDo}`,
    metadata: {
      diagnostic: true,
      category: diagnostic.category,
      fatal: diagnostic.fatal,
      level: diagnostic.level,
      errorPresentation: presented,
      ...(diagnostic.loggedAt ? { loggedAt: diagnostic.loggedAt } : {}),
    },
  };
}
