import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  DOCK_CHIPS,
  DOCK_CHIP_VISIBLE_CAP,
  DOCK_FOCUS_ANCHOR_CLASS,
  resolveEscapeRouting,
  splitDockChips,
  type DockChipDef,
} from './session-status-dock.rules';
import { SessionStatusDockComponent } from './session-status-dock.component';
import { HistoryIpcService } from '../../core/services/ipc/history-ipc.service';
import { IpcFacadeService, VcsIpcService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';

const specDirectory = dirname(fileURLToPath(import.meta.url));

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

/**
 * Approval and question surfaces, including transitive loop-question hosts:
 * `app-loop-outstanding-panel` renders `app-loop-question-row` for firstSeenRound
 * questions and its own "Earlier questions" answer controls, so any mount of it
 * inside the strip would hide live decisions behind a collapsed chip.
 */
const APPROVAL_OR_QUESTION_SELECTORS = [
  'app-user-action-request',
  'app-browser-approval-request',
  'app-ask-user-question-form',
  'app-async-question-answers',
  'app-loop-question-row',
  'app-loop-questions-chip',
  'app-loop-outstanding-panel',
];

const alwaysOnChip = (id: DockChipDef['id'], blocker = false): DockChipDef => ({
  id,
  blocker,
  icon: { paths: ['M12 2v20'] },
  describe: () => ({ label: id, title: `Toggle ${id}`, badge: null }),
});

describe('session-status-dock rules (Phase 5 handoff guard)', () => {
  let fixture: ComponentFixture<SessionStatusDockComponent>;
  const listSessionSnapshots = vi.fn(
    (): Promise<{ success: boolean; data: unknown[] }> => Promise.resolve({ success: true, data: [] }),
  );

  async function createDock(snapshots: unknown[] = []): Promise<void> {
    listSessionSnapshots.mockReset();
    listSessionSnapshots.mockImplementation(() => Promise.resolve({ success: true, data: snapshots }));
    await TestBed.configureTestingModule({
      imports: [SessionStatusDockComponent],
      providers: [
        { provide: HistoryIpcService, useValue: { listSessionSnapshots, resumeSession: vi.fn() } },
        // The chip panels construct their own dependencies when a chip opens;
        // stub the heavy ones so the guard can open every real chip.
        { provide: IpcFacadeService, useValue: { getApi: () => undefined } },
        {
          provide: VcsIpcService,
          useValue: {
            vcsIsRepo: vi.fn(() => Promise.resolve({ success: false })),
            vcsGetStatus: vi.fn(() => Promise.resolve({ success: false })),
          },
        },
        {
          provide: InstanceStore,
          useValue: {
            instanceActivities: signal(new Map()),
            getInstance: () => undefined,
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SessionStatusDockComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('workingDirectory', '/repo');
    fixture.componentRef.setInput('childrenIds', []);
    fixture.detectChanges();
  }

  async function settle(): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    fixture.detectChanges();
  }

  it('renders no approval or question component inside the strip, with every chip opened', async () => {
    await createDock([{ id: 'snap-1' }, { id: 'snap-2' }]);
    fixture.componentRef.setInput('childrenIds', ['child-1']);
    fixture.componentInstance.onReviewStarted();
    await settle();

    const strip = fixture.nativeElement.querySelector('.session-status-dock');
    expect(strip).toBeTruthy();
    const chips = strip.querySelectorAll('.dock-chips > .inspector-toggle[data-chip-id]');
    expect(chips.length).toBe(DOCK_CHIPS.length);
    for (const chip of Array.from(chips)) {
      (chip as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.inspector-panels')).toBeTruthy();
      for (const selector of APPROVAL_OR_QUESTION_SELECTORS) {
        expect(strip.querySelector(selector)).toBeNull();
      }
      // Answer controls (textareas, question rows) are decisions: never inside.
      expect(strip.querySelector('textarea')).toBeNull();
      expect(strip.querySelector('.question')).toBeNull();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      fixture.detectChanges();
    }

    const source = readFileSync(resolve(specDirectory, './session-status-dock.component.ts'), 'utf8');
    for (const selector of APPROVAL_OR_QUESTION_SELECTORS) {
      expect(source).not.toContain(selector);
    }
    expect(source).not.toContain('OutstandingPanel');
    const rulesSource = readFileSync(resolve(specDirectory, './session-status-dock.rules.ts'), 'utf8');
    expect(rulesSource).not.toContain("'outstanding'");
  });

  it('keeps the loop question surface mounted outside the strip in instance detail', () => {
    const hostSource = readFileSync(resolve(specDirectory, './instance-detail.component.html'), 'utf8');
    const panelIndex = hostSource.indexOf('app-loop-outstanding-panel');
    const dockIndex = hostSource.indexOf('<app-session-status-dock');
    expect(panelIndex).toBeGreaterThan(-1);
    expect(dockIndex).toBeGreaterThan(-1);
    // The question surface sits with the approvals, before the strip element.
    expect(panelIndex).toBeLessThan(dockIndex);
    expect(hostSource.indexOf('app-user-action-request')).toBeLessThan(panelIndex);
  });

  it('folds chips beyond the cap into a "+N more" control that opens the list', async () => {
    await createDock();
    fixture.componentRef.setInput('chipDefs', [
      alwaysOnChip('review'),
      alwaysOnChip('agents'),
      alwaysOnChip('checkpoints'),
      alwaysOnChip('goal'),
      alwaysOnChip('compact-first'),
      alwaysOnChip('helpers'),
    ]);
    await settle();

    const chipButtons = fixture.nativeElement.querySelectorAll(
      '.dock-chips > .inspector-toggle[data-chip-id]',
    );
    expect(chipButtons).toHaveLength(DOCK_CHIP_VISIBLE_CAP);
    expect(fixture.nativeElement.querySelector('[data-chip-id="helpers"]')).toBeNull();

    const overflowToggle = fixture.nativeElement.querySelector(
      '.dock-overflow-toggle',
    ) as HTMLButtonElement;
    expect(overflowToggle).toBeTruthy();
    expect(overflowToggle.textContent).toContain('+1 more');

    overflowToggle.click();
    fixture.detectChanges();

    const overflowList = fixture.nativeElement.querySelector('.dock-overflow-list');
    expect(overflowList).toBeTruthy();
    expect(overflowList.querySelector('[data-chip-id="helpers"]')).toBeTruthy();
  });

  it('Escape closes a chip panel and returns focus to the chip', async () => {
    await createDock();
    fixture.componentRef.setInput('chipDefs', [alwaysOnChip('checkpoints')]);
    await settle();
    const chip = fixture.nativeElement.querySelector(
      '[data-chip-id="checkpoints"]',
    ) as HTMLButtonElement;
    expect(chip.getAttribute('aria-expanded')).toBe('false');

    chip.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-checkpoint-timeline')).toBeTruthy();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-checkpoint-timeline')).toBeNull();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(chip);
  });

  it('renders nothing when no chip has content', async () => {
    await createDock();
    fixture.componentRef.setInput('chipDefs', [
      { ...alwaysOnChip('review'), describe: () => null },
      { ...alwaysOnChip('agents'), describe: () => null },
    ]);
    await settle();

    expect(fixture.nativeElement.querySelector('.session-status-dock')).toBeNull();
    expect(fixture.nativeElement.textContent.trim()).toBe('');

    // The strip may render nothing, but the Escape ladder's last focus target
    // must survive the empty state and hold focus — the dock host cannot be
    // that target (it is `display: contents` in a real browser).
    const anchor = fixture.nativeElement.querySelector(
      `.${DOCK_FOCUS_ANCHOR_CLASS}`,
    ) as HTMLElement;
    expect(anchor).toBeTruthy();
    anchor.focus();
    expect(document.activeElement).toBe(anchor);
  });

  it('shows the strip only through registered chips declaring content', async () => {
    await createDock();
    await settle();
    // Default registry with empty context: no review content, no children and
    // no checkpoints — nothing may render.
    expect(fixture.nativeElement.querySelector('.session-status-dock')).toBeNull();

    fixture.componentRef.setInput('chipDefs', [alwaysOnChip('helpers')]);
    await settle();
    expect(fixture.nativeElement.querySelector('[data-chip-id="helpers"]')).toBeTruthy();
  });

  it('renders nothing after the last content-bearing chip disappears while its panel is open', async () => {
    await createDock();
    fixture.componentRef.setInput('childrenIds', ['child']);
    await settle();
    const chip = fixture.nativeElement.querySelector(
      '[data-chip-id="agents"]',
    ) as HTMLButtonElement;
    chip.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-child-instances-panel')).toBeTruthy();

    fixture.componentRef.setInput('childrenIds', []);
    fixture.detectChanges();
    expect(fixture.componentInstance.chipViews()).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.session-status-dock')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-child-instances-panel')).toBeNull();
  });

  it('closes a panel whose chip loses content and does not silently reopen it', async () => {
    await createDock();
    fixture.componentInstance.onReviewStarted();
    fixture.componentRef.setInput('childrenIds', ['child']);
    await settle();
    const agents = fixture.nativeElement.querySelector(
      '[data-chip-id="agents"]',
    ) as HTMLButtonElement;
    agents.click();
    await settle();
    expect(fixture.nativeElement.querySelector('app-child-instances-panel')).toBeTruthy();

    fixture.componentRef.setInput('childrenIds', []);
    await settle();
    expect(fixture.nativeElement.querySelector('app-child-instances-panel')).toBeNull();
    // The strip stays for the review chip's content, but the empty Agents
    // panel must not linger and must not reopen when children come back.
    expect(fixture.nativeElement.querySelector('.session-status-dock')).toBeTruthy();

    fixture.componentRef.setInput('childrenIds', ['child-2']);
    await settle();
    const agentsAgain = fixture.nativeElement.querySelector(
      '[data-chip-id="agents"]',
    ) as HTMLButtonElement;
    expect(agentsAgain).toBeTruthy();
    expect(agentsAgain.getAttribute('aria-expanded')).toBe('false');
    expect(fixture.nativeElement.querySelector('app-child-instances-panel')).toBeNull();
  });

  it('Escape closes a panel opened from the overflow list and returns focus to its chip', async () => {
    await createDock();
    fixture.componentRef.setInput('chipDefs', [
      alwaysOnChip('review'),
      alwaysOnChip('goal'),
      alwaysOnChip('near-limit'),
      alwaysOnChip('helpers'),
      alwaysOnChip('compact-first'),
      alwaysOnChip('checkpoints'),
    ]);
    await settle();

    const overflowToggle = fixture.nativeElement.querySelector(
      '.dock-overflow-toggle',
    ) as HTMLButtonElement;
    overflowToggle.click();
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector(
      '[data-chip-id="checkpoints"]',
    ) as HTMLButtonElement;
    chip.focus();
    chip.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-checkpoint-timeline')).toBeTruthy();
    // The activated chip is the panel's trigger: it stays mounted and focused.
    expect(fixture.nativeElement.querySelector('[data-chip-id="checkpoints"]')).toBe(chip);
    expect(document.activeElement).toBe(chip);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-checkpoint-timeline')).toBeNull();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(chip);
    expect(fixture.nativeElement.contains(document.activeElement)).toBe(true);
  });

  it('Escape collapses an expanded overflow row and returns focus to the "+N more" control', async () => {
    await createDock();
    fixture.componentRef.setInput('chipDefs', [
      alwaysOnChip('review'),
      alwaysOnChip('goal'),
      alwaysOnChip('near-limit'),
      alwaysOnChip('helpers'),
      alwaysOnChip('compact-first'),
      alwaysOnChip('checkpoints'),
    ]);
    await settle();

    const overflowToggle = fixture.nativeElement.querySelector(
      '.dock-overflow-toggle',
    ) as HTMLButtonElement;
    overflowToggle.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.dock-overflow-list')).toBeTruthy();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();

    expect(fixture.componentInstance.overflowOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('.dock-overflow-list')).toBeNull();
    expect(document.activeElement).toBe(overflowToggle);
    expect(fixture.nativeElement.contains(document.activeElement)).toBe(true);
  });

  it('keeps openReviewPanel reachable before the first review runs', async () => {
    await createDock();
    await settle();
    expect(fixture.nativeElement.querySelector('.session-status-dock')).toBeNull();

    // Cmd/Ctrl+Shift+V opens the review workbench before any review exists;
    // while open, the review chip is its content, so the strip is not empty.
    fixture.componentInstance.openReviewPanel();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-instance-review-panel')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-chip-id="review"]')).toBeTruthy();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-instance-review-panel')).toBeNull();
    expect(fixture.nativeElement.querySelector('.session-status-dock')).toBeNull();
  });

  it('Escape closing a cold Review with no other chip keeps focus on the dock focus anchor', async () => {
    await createDock();
    await settle();
    fixture.componentInstance.openReviewPanel();
    fixture.detectChanges();
    const chip = fixture.nativeElement.querySelector(
      '[data-chip-id="review"]',
    ) as HTMLButtonElement;
    chip.focus();
    expect(document.activeElement).toBe(chip);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();

    // The cold Review chip leaves with its panel and the empty strip unmounts;
    // the always-rendered focus anchor survives the close and keeps keyboard
    // focus off <body>. Not the host: a real browser cannot focus an element
    // with `display: contents` (pinned in session-status-dock-focus.e2e.spec.ts).
    const anchor = fixture.nativeElement.querySelector(
      `.${DOCK_FOCUS_ANCHOR_CLASS}`,
    ) as HTMLElement;
    expect(chip.isConnected).toBe(false);
    expect(fixture.nativeElement.querySelector('.session-status-dock')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(fixture.nativeElement);
    expect(document.activeElement).toBe(anchor);
    expect(fixture.nativeElement.contains(document.activeElement)).toBe(true);
  });

  it('Escape closing a cold Review falls through a disabled composer to the focus anchor', async () => {
    const composerShell = document.createElement('div');
    composerShell.innerHTML =
      '<app-input-panel><textarea disabled></textarea></app-input-panel>';
    document.body.appendChild(composerShell);
    try {
      await createDock();
      await settle();
      fixture.componentInstance.openReviewPanel();
      fixture.detectChanges();
      const chip = fixture.nativeElement.querySelector(
        '[data-chip-id="review"]',
      ) as HTMLButtonElement;
      chip.focus();

      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      fixture.detectChanges();

      // The verifier's exact scenario: a cold Review, no other chip and a
      // disabled composer. A disabled textarea cannot take focus, so the
      // ladder must fall through it to the anchor — never <body>.
      const anchor = fixture.nativeElement.querySelector(
        `.${DOCK_FOCUS_ANCHOR_CLASS}`,
      ) as HTMLElement;
      const disabledComposer = composerShell.querySelector('textarea') as HTMLTextAreaElement;
      expect(chip.isConnected).toBe(false);
      expect(disabledComposer.disabled).toBe(true);
      expect(document.activeElement).not.toBe(disabledComposer);
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(anchor);
    } finally {
      composerShell.remove();
    }
  });

  it('Escape closing a cold Review falls to a remaining chip when one keeps content', async () => {
    await createDock();
    fixture.componentRef.setInput('childrenIds', ['child']);
    await settle();
    fixture.componentInstance.openReviewPanel();
    fixture.detectChanges();
    const reviewChip = fixture.nativeElement.querySelector(
      '[data-chip-id="review"]',
    ) as HTMLButtonElement;
    reviewChip.focus();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();

    const agentsChip = fixture.nativeElement.querySelector(
      '[data-chip-id="agents"]',
    ) as HTMLButtonElement;
    expect(agentsChip).toBeTruthy();
    expect(reviewChip.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(agentsChip);
    expect(fixture.nativeElement.contains(document.activeElement)).toBe(true);
  });

  it('Escape closing a cold Review focuses the composer input when the strip vanishes', async () => {
    const composerShell = document.createElement('div');
    composerShell.innerHTML = '<app-input-panel><textarea></textarea></app-input-panel>';
    document.body.appendChild(composerShell);
    try {
      await createDock();
      await settle();
      fixture.componentInstance.openReviewPanel();
      fixture.detectChanges();
      const chip = fixture.nativeElement.querySelector(
        '[data-chip-id="review"]',
      ) as HTMLButtonElement;
      chip.focus();

      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      fixture.detectChanges();

      const composerInput = composerShell.querySelector('textarea') as HTMLTextAreaElement;
      expect(chip.isConnected).toBe(false);
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(composerInput);
    } finally {
      composerShell.remove();
    }
  });

  it('Escape closing a cold Review restores focus to the original opener', async () => {
    await createDock();
    fixture.componentRef.setInput('childrenIds', ['child']);
    await settle();
    const opener = document.createElement('button');
    opener.textContent = 'outside control';
    document.body.appendChild(opener);
    try {
      // Focus that outside control first: it is the surface's opener.
      opener.focus();
      fixture.componentInstance.openReviewPanel();
      fixture.detectChanges();

      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      fixture.detectChanges();

      // The opener outranks the remaining-chip and composer fallbacks.
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
    }
  });

  it('styles the focus anchor as a real box, never display:contents or display:none', () => {
    // A stylesheet change is invisible to this jsdom suite (component styles
    // are blanked here), so the class-level contract is pinned textually and
    // the focus semantics run in session-status-dock-focus.e2e.spec.ts.
    const scssSource = readFileSync(
      resolve(specDirectory, './session-status-dock.component.scss'),
      'utf8',
    );
    const ruleStart = scssSource.indexOf(`.${DOCK_FOCUS_ANCHOR_CLASS} {`);
    expect(ruleStart).toBeGreaterThan(-1);
    const ruleBody = scssSource.slice(ruleStart, scssSource.indexOf('}', ruleStart));
    expect(ruleBody).not.toContain('display: contents');
    expect(ruleBody).not.toContain('display: none');
  });
});

describe('splitDockChips', () => {
  it('folds chips beyond the cap and keeps blocker chips visible', () => {
    const defs = [
      { id: 'a', blocker: false },
      { id: 'b', blocker: false },
      { id: 'c', blocker: false },
      { id: 'd', blocker: false },
      { id: 'e', blocker: false },
      { id: 'f', blocker: true },
    ];
    const { visible, overflow } = splitDockChips(defs);
    expect(visible).toHaveLength(DOCK_CHIP_VISIBLE_CAP);
    expect(overflow.map((d) => d.id)).toEqual(['e']);
    expect(visible.map((d) => d.id)).toEqual(['a', 'b', 'c', 'd', 'f']);
  });

  it('never folds blocker chips even past the cap', () => {
    const defs = [
      { id: 'b1', blocker: true },
      { id: 'x', blocker: false },
      { id: 'b2', blocker: true },
      { id: 'y', blocker: false },
    ];
    const { visible, overflow } = splitDockChips(defs, 2);
    expect(visible.map((d) => d.id)).toEqual(['b1', 'b2']);
    expect(overflow.map((d) => d.id)).toEqual(['x', 'y']);
  });

  it('shows every chip while the registry fits the cap', () => {
    const { visible, overflow } = splitDockChips(DOCK_CHIPS);
    expect(overflow).toHaveLength(0);
    expect(visible.map((d) => d.id)).toEqual(DOCK_CHIPS.map((d) => d.id));
  });
});

describe('DOCK_CHIPS registry', () => {
  it('is a typed chip-definition list with a visible cap of five', () => {
    expect(DOCK_CHIPS.map((def: DockChipDef) => def.id)).toEqual([
      'review',
      'agents',
      'checkpoints',
    ]);
    expect(DOCK_CHIP_VISIBLE_CAP).toBe(5);
  });

  it('registers no decision chip: questions and approvals stay outside the strip', () => {
    const ids = DOCK_CHIPS.map((def: DockChipDef) => def.id);
    expect(ids).not.toContain('outstanding');
    for (const def of DOCK_CHIPS) {
      expect(def.blocker).toBe(false);
    }
  });
});

describe('resolveEscapeRouting', () => {
  it('closes the chip panel first even while a turn is in flight', () => {
    expect(
      resolveEscapeRouting({ dockPanelWasOpen: true, instanceStatus: 'busy' }),
    ).toBe('chip-panel');
    expect(
      resolveEscapeRouting({ dockPanelWasOpen: true, instanceStatus: 'idle' }),
    ).toBe('chip-panel');
  });

  it.each([
    'busy',
    'processing',
    'thinking_deeply',
    'waiting_for_permission',
    'respawning',
    'interrupting',
    'cancelling',
    'interrupt-escalating',
  ])('interrupts an in-flight turn on %s when no panel is open', (status) => {
    expect(resolveEscapeRouting({ dockPanelWasOpen: false, instanceStatus: status })).toBe(
      'interrupt',
    );
  });

  it('never interrupts an idle session', () => {
    expect(resolveEscapeRouting({ dockPanelWasOpen: false, instanceStatus: 'idle' })).toBeNull();
    expect(resolveEscapeRouting({ dockPanelWasOpen: false, instanceStatus: 'ready' })).toBeNull();
    expect(resolveEscapeRouting({ dockPanelWasOpen: false, instanceStatus: undefined })).toBeNull();
    expect(resolveEscapeRouting({ dockPanelWasOpen: false, instanceStatus: null })).toBeNull();
  });
});
