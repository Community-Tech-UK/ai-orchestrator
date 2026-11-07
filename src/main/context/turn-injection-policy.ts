import { contentTokens } from '../memory/retrieval-eval/lesson-use-detector';

export const TURN_INJECTION_CAP = 8_000;

/** Pure, per-instance state. Only accepted chunks consume the boundary budget. */
export class TurnInjectionPolicy {
  private boundary = '';
  private readonly seen = new Set<string>();
  private readonly identifiers = new Set<string>();
  private readonly recent: Set<string>[] = [];
  private injectedTokens = 0;
  matches(sessionId: string, restartEpoch: number): boolean { return this.boundary === JSON.stringify([sessionId, restartEpoch]); }
  get remaining(): number { return Math.max(0, TURN_INJECTION_CAP - this.injectedTokens); }

  begin(sessionId: string, restartEpoch: number, message: string): { retrieve: boolean; code: boolean; reason?: string } {
    const boundary = JSON.stringify([sessionId, restartEpoch]);
    if (boundary !== this.boundary) { this.reset(); this.boundary = boundary; }
    const words = contentTokens(message);
    const names = identifierNames(message);
    const freshName = names.some(name => !this.identifiers.has(name));
    const previous = new Set(this.recent.flatMap(terms => [...terms]));
    const overlap = words.size ? [...words].filter(word => previous.has(word)).length / words.size : 1;
    const code = freshName || !this.recent.length || overlap < 0.3;
    names.forEach(name => this.identifiers.add(name));
    this.recent.push(words); if (this.recent.length > 3) this.recent.shift();
    if (words.size < 4) return { retrieve: false, code: false, reason: 'short reply' };
    if (!this.remaining) return { retrieve: false, code: false, reason: 'session cap reached' };
    return { retrieve: true, code };
  }

  take(ids: string[], tokens: number): boolean {
    if (!ids.length || ids.some(id => this.seen.has(id)) || !Number.isFinite(tokens) || tokens <= 0 || tokens > this.remaining) return false;
    ids.forEach(id => this.seen.add(id)); this.injectedTokens += tokens;
    return true;
  }

  reset(): void { this.boundary = ''; this.seen.clear(); this.identifiers.clear(); this.recent.length = 0; this.injectedTokens = 0; }
}

/** Maximal runs always consume input; failed recognition never retries a suffix.
 * The optional extension and symbol markers use bounded lookahead. */
function identifierNames(message: string): string[] {
  const names: string[] = [];
  for (const [run] of message.matchAll(/[\w$.-]+(?:[/\\][\w$.-]+)*/g)) {
    if (/[/\\]/.test(run)) { names.push(run); continue; }
    // A sentence-ending dot is punctuation, not part of a filename/symbol.
    for (const [part] of run.matchAll(/[\w$-]+(?:\.[a-zA-Z]{1,8}\b)?/g)) {
      if (part.includes('.')) { names.push(part); continue; }
      for (const [symbol] of part.matchAll(/[a-zA-Z_$][\w$]*/g)) {
        if (/[A-Z][a-z]|_[a-zA-Z]/.test(symbol.slice(1))) names.push(symbol);
      }
    }
  }
  return names;
}
