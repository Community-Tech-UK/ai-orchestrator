/**
 * UX1 — the tooltip POLICY, separated from the directive that applies it.
 *
 * The plan is explicit that we copy the policy from the reference projects, not
 * their React/Solid/Lit implementations. Keeping the rules here as pure
 * functions means the rules are unit-testable without a DOM, and the directive
 * stays a thin adapter over them.
 *
 * Every constant below is a decision with a reason, not a taste:
 *
 * - **Never 0ms.** A zero-delay tooltip flashes a trail of boxes across an icon
 *   rail as the pointer crosses it. CodePilot ships 0 and it is the single
 *   worst thing about its chrome; AO's own sidebar had the same problem.
 * - **200ms on icon rails, 600ms for overflow-only titles.** An icon needs its
 *   label quickly because the icon alone is not self-describing. An overflow
 *   tooltip only restates text the user can already partly see, so it should
 *   stay out of the way until they clearly paused on it.
 * - **A skip window.** Once one tooltip has shown, moving along the rail should
 *   not re-pay the delay each time; within `SKIP_WINDOW_MS` the next opens
 *   immediately. This is what makes a rail feel like one control rather than
 *   twelve.
 * - **2000ms for dense HUD chips.** They sit inside a strip the user reads as a
 *   whole; popping a tooltip while their eye travels across it is noise.
 */

/** Pointer dwell before an ordinary tooltip opens. */
export const TOOLTIP_DELAY_MS = 200;
/** Dwell for a tooltip that only restates a truncated visible label. */
export const OVERFLOW_TOOLTIP_DELAY_MS = 600;
/** Dwell for tooltips inside a dense metric strip. */
export const DENSE_TOOLTIP_DELAY_MS = 2000;
/** After a tooltip closes, the next one within this window opens immediately. */
export const SKIP_WINDOW_MS = 300;
/** Touch long-press before a tooltip opens. */
export const TOUCH_DELAY_MS = 450;
/** How long a touch-triggered tooltip stays up before self-dismissing. */
export const TOUCH_VISIBLE_MS = 900;
/** After a click, suppress hover-reopen for this long. */
export const POST_CLICK_BLOCK_MS = 300;

/** Where a tooltip's timing profile comes from. */
export type TooltipVariant =
  /** Icon buttons, status dots, rails — the icon is not self-describing. */
  | 'default'
  /** Only restates a truncated label the user can already partly read. */
  | 'overflow'
  /** Inside a dense metric strip that is read as a whole. */
  | 'dense';

export function openDelayFor(variant: TooltipVariant, skipActive: boolean): number {
  if (skipActive) return 0;
  switch (variant) {
    case 'overflow': return OVERFLOW_TOOLTIP_DELAY_MS;
    case 'dense': return DENSE_TOOLTIP_DELAY_MS;
    case 'default': return TOOLTIP_DELAY_MS;
  }
}

export interface TooltipSuppressionInput {
  /** Resolved tooltip text. */
  text: string | null | undefined;
  /** The trigger's own visible text, when it has any. */
  visibleLabel?: string | null;
  /** True when the trigger's label is visually truncated. */
  truncated?: boolean;
  /** `aria-expanded="true"` — a menu/popover is open from this trigger. */
  expanded?: boolean;
  /** Explicitly disabled by the caller. */
  disabled?: boolean;
  /** Within the post-click suppression window. */
  recentlyClicked?: boolean;
}

/**
 * Should this tooltip be suppressed entirely?
 *
 * The redundancy rule is the subtle one: a tooltip that repeats a label the
 * user can already read in full is pure noise, and worse, screen readers get a
 * duplicate accessible name. It is only useful when the label is truncated.
 */
export function shouldSuppressTooltip(input: TooltipSuppressionInput): boolean {
  if (input.disabled) return true;
  const text = input.text?.trim();
  if (!text) return true;
  // A trigger with an open menu already shows the user more than a tooltip would.
  if (input.expanded) return true;
  if (input.recentlyClicked) return true;
  if (!input.truncated && isRedundantWithLabel(text, input.visibleLabel)) return true;
  return false;
}

/** Case- and whitespace-insensitive equality against the visible label. */
export function isRedundantWithLabel(text: string, visibleLabel: string | null | undefined): boolean {
  const label = visibleLabel?.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!label) return false;
  return label === text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Should a focus event open the tooltip?
 *
 * Keyboard focus should; a click that incidentally focuses the button should
 * not, or every click leaves a tooltip hanging over the thing you just pressed.
 * `:focus-visible` is the browser's own answer to that question, so we ask it
 * rather than tracking input modality ourselves.
 */
export function shouldOpenOnFocus(element: { matches(selector: string): boolean }): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    // Older engines without :focus-visible — fail closed rather than opening a
    // tooltip on every mouse click.
    return false;
  }
}

/**
 * The accessible-name contract for an icon button (`TooltipIconButton`).
 *
 * An icon button MUST have both a tooltip and an accessible name, and they must
 * be the same string — two different strings mean the sighted and screen-reader
 * users are told different things about the same control.
 */
export function resolveIconButtonAria(text: string): { ariaLabel: string; tooltip: string } {
  const trimmed = text.trim();
  return { ariaLabel: trimmed, tooltip: trimmed };
}

/**
 * `aria-describedby` merge: the tooltip's id joins any ids the trigger already
 * had, and removing it must restore exactly what was there before. Blindly
 * setting and then clearing the attribute is how a trigger loses an unrelated
 * description it owned all along.
 */
export function mergeDescribedBy(existing: string | null, tooltipId: string): string {
  const ids = (existing ?? '').split(/\s+/).filter(Boolean);
  if (ids.includes(tooltipId)) return ids.join(' ');
  return [...ids, tooltipId].join(' ');
}

/** Inverse of {@link mergeDescribedBy}. Returns `null` when nothing remains. */
export function unmergeDescribedBy(existing: string | null, tooltipId: string): string | null {
  const ids = (existing ?? '').split(/\s+/).filter(Boolean).filter((id) => id !== tooltipId);
  return ids.length > 0 ? ids.join(' ') : null;
}
