/**
 * Help content model - typed sections rendered by the shared Help & tips pane.
 *
 * Every Control Center surface and Settings tab has a `HelpEntry` describing
 * what the page does, how to use it, and recommended settings. Content lives
 * in data files (see `content/`) so the pane component stays generic and the
 * compiler can enforce full coverage via `Record<Id, HelpEntry>` registries.
 */

export type HelpCalloutVariant = 'info' | 'tip' | 'warning';

/** A variant-styled note (info explanation, tip, or warning). */
export interface HelpCalloutSection {
  readonly kind: 'callout';
  readonly variant: HelpCalloutVariant;
  readonly heading: string;
  readonly body: string;
}

/** A bulleted (`list`) or numbered (`steps`) list under a small heading. */
export interface HelpListSection {
  readonly kind: 'list' | 'steps';
  readonly heading: string;
  readonly items: readonly string[];
}

/** A monospace block, e.g. a config example. */
export interface HelpCodeSection {
  readonly kind: 'code';
  readonly heading: string;
  readonly code: string;
}

/** One recommended setting: the control, the suggested value, and why. */
export interface HelpRecommendation {
  readonly label: string;
  readonly value: string;
  readonly why: string;
}

/** A "Recommended settings" block. */
export interface HelpRecommendSection {
  readonly kind: 'recommend';
  readonly heading?: string;
  readonly items: readonly HelpRecommendation[];
}

export type HelpSection =
  | HelpCalloutSection
  | HelpListSection
  | HelpCodeSection
  | HelpRecommendSection;

/** The full help content for one page or settings tab. */
export interface HelpEntry {
  readonly sections: readonly HelpSection[];
}

/**
 * Live subsystem status injected by a host shell (e.g. provider readiness on
 * the Models tab). Rendered as a callout directly after the first section.
 */
export interface HelpLiveStatus {
  readonly variant: HelpCalloutVariant;
  readonly text: string;
}
