import type { Lexer, Token, TokenizerAndRendererExtension, Tokens } from 'marked';

// Disjoint alternatives keep scanning linear, including incomplete streaming tails.
const FOLLOWUP_SOURCE = String.raw`:{1,2}codex-followup\[((?:\\.|[^\[\]\\\n])+)\]\{prompt="((?:\\.|[^"\\])*)"\}`;
const FOLLOWUP_AT_START = new RegExp(`^${FOLLOWUP_SOURCE}`);

interface FollowupToken extends Tokens.Generic {
  type: 'codexFollowup';
  label: string;
  prompt: string;
}

interface InlineScan {
  length: number;
  positions: number[];
  next: number;
}

// Tokens identify each recursive inline context; weak keys release parse state
// when the lexer and its tokens are discarded. No transcript strings are retained.
const inlineScans = new WeakMap<Token[], InlineScan>();
const activeScans = new WeakMap<Lexer, InlineScan>();

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export const codexFollowupExtension: TokenizerAndRendererExtension = {
  name: 'codexFollowup',
  level: 'inline',
  start(source) {
    // Marked excludes the current first character from this remaining suffix.
    const scan = activeScans.get(this.lexer);
    if (!scan) return;
    const offset = scan.length - source.length;
    while (scan.next < scan.positions.length && scan.positions[scan.next] < offset) scan.next++;
    return scan.positions[scan.next] === undefined ? undefined : scan.positions[scan.next] - offset;
  },
  tokenizer(source, tokens): FollowupToken | undefined {
    let scan = inlineScans.get(tokens);
    if (!scan) {
      scan = {
        length: source.length,
        positions: Array.from(source.matchAll(/:{1,2}codex-followup\[/g), (match) => match.index),
        next: 0,
      };
      inlineScans.set(tokens, scan);
    }
    activeScans.set(this.lexer, scan);
    const match = FOLLOWUP_AT_START.exec(source);
    if (!match) return undefined;

    let prompt: string;
    try {
      prompt = JSON.parse(`"${match[2]}"`) as string;
    } catch {
      // Invalid/unfinished attribute syntax remains ordinary visible text.
      return undefined;
    }
    const label = match[1].replace(/\\([\\[\]])/g, '$1');
    if (!label.trim() || !prompt.trim()) return undefined;
    return { type: 'codexFollowup', raw: match[0], label, prompt };
  },
  renderer(token) {
    const { label, prompt } = token as FollowupToken;
    // JSON escapes control characters before HTML can normalize or replace them.
    return `<button type="button" class="codex-followup" data-followup-prompt="${escapeHtml(JSON.stringify(prompt))}" title="Copy follow-up prompt" aria-label="${escapeHtml(`Copy follow-up prompt: ${label}`)}">${escapeHtml(label)}</button>`;
  },
};

/** Keep directive payloads intact while transforming the surrounding document. */
export function transformTextWithFollowups(content: string, transform: (text: string) => string): string {
  // Scan authored markers once; growing prefixes and rescanning long input is quadratic.
  const usedNonces = new Set<string>();
  for (const match of content.matchAll(/\uE000codex-followup-(\d+):/g)) usedNonces.add(match[1]);
  let nonce = 0;
  while (usedNonces.has(String(nonce))) nonce++;
  const prefix = `\uE000codex-followup-${nonce}:`;
  const directives: string[] = [];
  const protectedContent = content.replace(new RegExp(FOLLOWUP_SOURCE, 'g'), (directive) => {
    const index = directives.push(directive) - 1;
    return `${prefix}${index}\uE001`;
  });
  // Transform the whole document so enclosing orchestration blocks still strip
  // correctly and inline whitespace around each directive remains unchanged.
  return transform(protectedContent).replace(new RegExp(`${prefix}(\\d+)\uE001`, 'g'),
    (_placeholder, index: string) => directives[Number(index)]);
}
