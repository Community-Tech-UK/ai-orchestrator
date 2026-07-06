/**
 * Help Pane - collapsible right-hand "Help & tips" rail.
 *
 * Renders a `HelpEntry` from the help-content registries so every Control
 * Center surface and Settings tab gets a consistent contextual help panel.
 * The host shell owns collapse persistence; this component only renders and
 * emits toggle events. An optional `status` input lets shells inject a live
 * subsystem summary (rendered directly after the first section).
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { InlineHelpComponent } from './inline-help.component';
import type { HelpEntry, HelpLiveStatus, HelpSection } from './help-content.types';

const EMPTY_ENTRY: HelpEntry = { sections: [] };

@Component({
  selector: 'app-help-pane',
  standalone: true,
  imports: [InlineHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './help-pane.component.html',
  styleUrl: './help-pane.component.scss',
  host: {
    '[class.collapsed]': 'collapsed()',
  },
})
export class HelpPaneComponent {
  /** The help content to render. */
  readonly entry = input<HelpEntry>(EMPTY_ENTRY);
  /** Whether the pane is collapsed to a thin rail. */
  readonly collapsed = input(false);
  /** Optional live status callout injected after the first section. */
  readonly status = input<HelpLiveStatus | null>(null);
  /** Heading used for the live status callout. */
  readonly statusHeading = input('Live status');

  /** Emitted when the user clicks the collapse/expand affordance. */
  readonly toggled = output<void>();

  /** Entry sections with the live status callout spliced in after the lead. */
  readonly renderSections = computed<readonly HelpSection[]>(() => {
    const sections = this.entry().sections;
    const live = this.status();
    if (!live || sections.length === 0) {
      return sections;
    }
    const statusSection: HelpSection = {
      kind: 'callout',
      variant: live.variant,
      heading: this.statusHeading(),
      body: live.text,
    };
    return [sections[0], statusSection, ...sections.slice(1)];
  });
}
