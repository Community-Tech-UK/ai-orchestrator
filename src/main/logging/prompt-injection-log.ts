import type { SystemPromptBlockKind } from '../context/prompt-injection-contract';
import { getLogger } from './logger';
import type { PromptSurface } from './prompt-surfaces';

/**
 * One debug line per prompt injection: which surface, how many characters, and for which session.
 * A surface is a key of the budget table in `context/prompt-budgets.spec.ts` (see `prompt-surfaces.ts`), or an
 * advisory system-prompt block with its own ceiling, so a size seen in a log can be compared with its budget.
 * Empty text is not an injection and logs nothing.
 */
export function logPromptInjection(surface: PromptSurface | SystemPromptBlockKind, text: string | null | undefined, session?: string): void {
  if (!text) return;
  getLogger('PromptInjection').debug('Prompt injected', { surface, characters: text.length, session });
}
