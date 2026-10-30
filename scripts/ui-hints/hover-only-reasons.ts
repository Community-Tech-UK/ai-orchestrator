const prefix = 'src/renderer/app/features/';
export const HOVER_ONLY_REASONS: Record<string, string> = {
  [prefix + 'loop/loop-toggle.component.ts#span.lt-label']: 'the focusable switch beside it carries the same complete explanation',
  [prefix + 'automations/automations-page.component.ts#label.hidden-label']: 'the label is associated with automation-hidden-control; the same complete explanation is on its focusable checkbox',
  [prefix + 'codebase/codebase-search.component.ts#label.toggle-label']: 'the label is associated with hyde-toggle; the same complete explanation is on its focusable checkbox',
  [prefix + 'instance-detail/context-attribution-panel.component.ts#div.segment']: 'the visible legend below lists the same source labels and token counts',
  [prefix + 'instance-list/instance-list.component.ts#span.project-draft-pill']: 'visible text reads Draft; the hint only adds when the draft was last saved',
  [prefix + 'instance-list/instance-list.component.ts#span.history-entry-time']: 'visible text is the time; the hint says whether it is created or last-interacted, which the sort control also shows',
  ['src/renderer/app/app.component.ts#span.title-activity-chip']: 'visible text reads Sending N, and the resume toast shows Sending N queued messages at the same time',
  [prefix + 'instance-list/instance-row.component.ts#span.approval-chip']: 'visible text already reads Awaiting approval',
  [prefix + 'instance-list/instance-row.component.ts#span.remote-badge']: 'visible text carries offline when disconnected',
  [prefix + 'instance-list/instance-row.component.ts#div.diff-stats']: 'visible text is the +N/-N counts themselves',
  [prefix + 'loop/loop-control.component.ts#span.ls-pill']: 'visible text is the status label',
  [prefix + 'loop/loop-control.component.ts#span.ls-text']: 'visible text is the metric numbers being explained',
  [prefix + 'loop/loop-control.component.ts#span.lp-badge']: 'visible text is the chip/badge wording being explained',
  [prefix + 'loop/loop-control.component.ts#div.loop-gate']: 'visible text is the gate step labels',
};
