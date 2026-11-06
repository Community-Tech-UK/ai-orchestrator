/**
 * Rules for the session status dock — the one strip for optional chips above
 * the message box (C13.12). A new chip registers into `DOCK_CHIPS`; it must not
 * invent a new spot. Approvals and questions never live inside this strip, so
 * collapsing it can never hide a decision. That includes B5 loop questions and
 * the loop Outstanding panel (needs-human items and open questions): they are
 * decisions, so they mount beside the approvals in `InstanceDetailComponent`,
 * never behind a chip.
 */

export type DockChipId =
  | 'review'
  | 'agents'
  | 'checkpoints'
  /** Planned registrations; ids are reserved so each lands typed in `DOCK_CHIPS`. */
  | 'goal'
  | 'compact-first'
  | 'near-limit'
  | 'helpers';

export interface DockChipIconCircle {
  cx: number;
  cy: number;
  r: number;
}

export interface DockChipIconLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DockChipIcon {
  paths?: readonly string[];
  circles?: readonly DockChipIconCircle[];
  lines?: readonly DockChipIconLine[];
}

export interface DockChipBadge {
  text: string;
  variant: 'default' | 'error' | 'running';
}

export interface DockChipPresentation {
  label: string;
  title: string;
  badge: DockChipBadge | null;
}

export interface DockChipContext {
  reviewHasContent: boolean;
  reviewIssueCount: number | null;
  reviewHasErrors: boolean;
  childCount: number;
  checkpointCount: number;
}

export interface DockChipDef {
  id: DockChipId;
  /** Needs-a-human chips sort first and never fold into "+N more". */
  blocker: boolean;
  icon: DockChipIcon;
  /** Screen-reader line when the chip appears; absent means nothing is announced. */
  announce?: string;
  /** Return null when the chip has nothing to show; it is hidden then. */
  describe(ctx: DockChipContext, open: boolean): DockChipPresentation | null;
}

/**
 * Five chips fit the strip today and later additions (a provider's goal, a
 * near-limit warning, helper agents) register beyond that, so five stay visible
 * and the rest fold behind "+N more". This plan's guard spec owns this number;
 * change it only with that spec.
 */
export const DOCK_CHIP_VISIBLE_CAP = 5;

/**
 * The Escape ladder's last focus target. The dock host is `display: contents`
 * (it must never become a layout box in the strip's parent), and a real browser
 * cannot focus an element without a box — so the ladder ends on this
 * always-rendered, programmatic-only anchor instead of the host. It is styled
 * off-flow in `session-status-dock.component.scss`, so it exists even when the
 * strip renders nothing and never changes layout. The real-browser guard
 * (`session-status-dock-focus.e2e.spec.ts`) pins the browser half of this
 * contract against the compiled stylesheet; `session-status-dock.rules.spec.ts`
 * pins the wiring.
 */
export const DOCK_FOCUS_ANCHOR_CLASS = 'dock-focus-anchor';

const reviewChip: DockChipDef = {
  id: 'review',
  blocker: false,
  icon: {
    paths: [
      'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
      'M14 2v6h6',
      'M16 13H8',
      'M16 17H8',
    ],
  },
  announce: 'Review results available.',
  // The review panel is a workbench the user opens (Cmd/Ctrl+Shift+V) before
  // any review exists, so the chip — the panel's trigger — keeps its
  // presentation while the panel is open. Content-list chips (agents,
  // checkpoints) do not: they hide when their list empties even while open,
  // so the strip can render nothing whenever no chip has content.
  describe: (ctx, open) => {
    if (!ctx.reviewHasContent && !open) {
      return null;
    }
    let badge: DockChipBadge | null = null;
    if (!open) {
      badge =
        ctx.reviewIssueCount !== null
          ? {
              text: `${ctx.reviewIssueCount} ${ctx.reviewIssueCount === 1 ? 'issue' : 'issues'}`,
              variant: ctx.reviewHasErrors ? 'error' : 'default',
            }
          : { text: 'running', variant: 'running' };
    }
    return { label: 'Review', title: 'Toggle review panel', badge };
  },
};

const agentsChip: DockChipDef = {
  id: 'agents',
  blocker: false,
  icon: {
    paths: [
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
      'M22 21v-2a4 4 0 0 0-3-3.87',
      'M16 3.13a4 4 0 0 1 0 7.75',
    ],
    circles: [{ cx: 9, cy: 7, r: 4 }],
  },
  describe: (ctx) =>
    ctx.childCount > 0
      ? {
          label: `Agents (${ctx.childCount})`,
          title: 'Toggle child agents',
          badge: null,
        }
      : null,
};

const checkpointsChip: DockChipDef = {
  id: 'checkpoints',
  blocker: false,
  icon: {
    paths: ['M12 7v5l3 2'],
    circles: [{ cx: 12, cy: 12, r: 9 }],
  },
  describe: (ctx, open) =>
    ctx.checkpointCount > 0
      ? {
          label: 'Checkpoints',
          title: 'Toggle checkpoints',
          badge: open ? null : { text: String(ctx.checkpointCount), variant: 'default' },
        }
      : null,
};

/** New chips register here (order is display order). */
export const DOCK_CHIPS: readonly DockChipDef[] = [
  reviewChip,
  agentsChip,
  checkpointsChip,
];

/**
 * Chooses which chips the strip shows: blocker chips are never folded away, and
 * display order stays the registry's so the row does not jump as content
 * changes. Non-blocker chips beyond the cap fold into "+N more".
 */
export function splitDockChips<T extends { id: string; blocker: boolean }>(
  defs: readonly T[],
  cap: number = DOCK_CHIP_VISIBLE_CAP,
): { visible: readonly T[]; overflow: readonly T[] } {
  const limit = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DOCK_CHIP_VISIBLE_CAP;
  const visibleIds = new Set<string>(defs.filter((def) => def.blocker).map((def) => def.id));
  let slots = Math.max(0, limit - visibleIds.size);
  for (const def of defs) {
    if (slots <= 0) break;
    if (visibleIds.has(def.id)) continue;
    visibleIds.add(def.id);
    slots--;
  }
  return {
    visible: defs.filter((def) => visibleIds.has(def.id)),
    overflow: defs.filter((def) => !visibleIds.has(def.id)),
  };
}

/** Where Escape goes when the instance view holds both a dock and a live turn. */
export type EscapeRouting = 'chip-panel' | 'interrupt' | null;

/** Statuses whose in-flight turn Escape is allowed to interrupt. */
const ESCAPE_INTERRUPTABLE_STATUSES: readonly string[] = [
  'busy',
  'processing',
  'thinking_deeply',
  'waiting_for_permission',
  'respawning',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
];

/**
 * Escape closes the dock's open surfaces first (an open chip panel, then the
 * expanded overflow row), and only interrupts when the dock has nothing open
 * and a turn is actually in flight — a dock surface must never steal the
 * interrupt, and a stray Escape must never interrupt an idle session.
 */
export function resolveEscapeRouting(input: {
  /** True when a dock surface was open and the Escape dismisses it. */
  dockPanelWasOpen: boolean;
  instanceStatus: string | null | undefined;
}): EscapeRouting {
  if (input.dockPanelWasOpen) {
    return 'chip-panel';
  }
  if (input.instanceStatus && ESCAPE_INTERRUPTABLE_STATUSES.includes(input.instanceStatus)) {
    return 'interrupt';
  }
  return null;
}
