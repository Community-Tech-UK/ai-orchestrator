/**
 * Output styles (claude2_todo #29).
 *
 * An `outputStyle` setting selects a built-in style whose directive is appended
 * to the system prompt at session start, changing *how* the agent communicates
 * (without changing what it can do). Mirrors Claude Code's output-style concept
 * (Explanatory / Learning / …) but, to stay low-risk, **appends a style
 * directive** rather than swapping the whole base prompt.
 *
 * The default style is a no-op, so the feature is inert until a user opts in —
 * zero behavior change otherwise. The core is pure (`applyOutputStyle`), so it
 * is fully unit-testable independently of the instance lifecycle.
 */

export type OutputStyleName = 'default' | 'explanatory' | 'learning' | 'concise';

export interface OutputStyleDefinition {
  name: OutputStyleName;
  label: string;
  /** Text appended to the system prompt. Empty for `default` (no-op). */
  directive: string;
}

export const BUILT_IN_OUTPUT_STYLES: Record<OutputStyleName, OutputStyleDefinition> = {
  default: {
    name: 'default',
    label: 'Default',
    directive: '',
  },
  explanatory: {
    name: 'explanatory',
    label: 'Explanatory',
    directive:
      'Output style — Explanatory: as you work, add brief "Insight" asides that explain *why* you chose an approach and the trade-offs involved, so the user learns from your reasoning. Keep them short and skippable; never let them slow the work down.',
  },
  learning: {
    name: 'learning',
    label: 'Learning',
    directive:
      'Output style — Learning: collaborate with the user. Where it helps them learn, pause and hand off a small, well-scoped piece for them to decide or implement (mark it clearly, e.g. `TODO(human): …`), and explain key concepts as you go. Keep momentum — only hand off pieces that are genuinely instructive.',
  },
  concise: {
    name: 'concise',
    label: 'Concise',
    directive:
      'Output style — Concise: minimize prose. Prefer short, direct answers, bullet points, and code over explanation. Skip pleasantries and do not restate the question. Lead with the answer.',
  },
};

const VALID_NAMES = new Set<string>(Object.keys(BUILT_IN_OUTPUT_STYLES));

export function isOutputStyleName(value: unknown): value is OutputStyleName {
  return typeof value === 'string' && VALID_NAMES.has(value);
}

/** Resolve a style name to its definition; unknown / falsy → the default no-op. */
export function resolveOutputStyle(name: string | undefined | null): OutputStyleDefinition {
  return isOutputStyleName(name) ? BUILT_IN_OUTPUT_STYLES[name] : BUILT_IN_OUTPUT_STYLES.default;
}

/**
 * Append the selected style's directive to `systemPrompt`. Returns the prompt
 * unchanged for the default/unknown style (the inert path). Pure.
 */
export function applyOutputStyle(systemPrompt: string, name: string | undefined | null): string {
  const directive = resolveOutputStyle(name).directive;
  if (!directive) return systemPrompt;
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${directive}` : directive;
}

/** Providers whose system prompt this path actually feeds to the CLI. */
const OUTPUT_STYLE_INJECTABLE_PROVIDERS = new Set<string>([
  'claude', 'codex', 'gemini', 'copilot', 'cursor', 'auto',
]);

export function isOutputStyleInjectableProvider(provider: string | undefined): boolean {
  // Unknown/undefined providers default to injectable — the system prompt is
  // built here regardless; a provider that ignores it simply won't apply it.
  return provider === undefined || OUTPUT_STYLE_INJECTABLE_PROVIDERS.has(provider);
}

/** List built-in styles for a settings/renderer picker. */
export function listOutputStyles(): OutputStyleDefinition[] {
  return Object.values(BUILT_IN_OUTPUT_STYLES);
}
