/**
 * Real-render tests for the instance row.
 *
 * This component had no spec of any kind, and BOTH tooltip regressions in this
 * wave originated here: the Terminate button losing its only hover disclosure,
 * and the status dots nesting inside the leading indicator so two overlapping
 * tooltips opened at once. Neither was caught by a test — the guards that found
 * them afterwards are regex scans of the template source and a synthetic
 * two-span fixture, neither of which renders this markup.
 *
 * So these tests drive the real component with the real directive: hover the
 * real elements, and assert what a user would actually see.
 */
import { ChangeDetectionStrategy, Component, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { InstanceRowComponent } from './instance-row.component';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import type { Instance } from '../../../../shared/types/instance.types';

// This component uses `templateUrl`, so the usual `() => Promise.resolve('')`
// resolver used by sibling specs would render NOTHING and every assertion here
// would pass or fail for the wrong reason. Load the real template; stylesheets
// stay empty because they are irrelevant to markup and naming.
await resolveComponentResources(async (url: string) =>
  (url.endsWith('.html') ? readFileSync(join(__dirname, basename(url)), 'utf8') : ''));

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    name: 'Test instance',
    provider: 'claude',
    status: 'idle',
    workingDirectory: '/tmp/project',
    ...overrides,
  } as Instance;
}

@Component({
  standalone: true,
  imports: [InstanceRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-instance-row [instance]="instance()" [isLooping]="false" />`,
})
class HostComponent {
  readonly instance = signal<Instance>(makeInstance());
}

function openTooltips(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[role="tooltip"]'));
}

let nodes: Record<string, { name: string; status: string; connected?: boolean }> = {};

describe('InstanceRowComponent — tooltip disclosure', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: RemoteNodeStore, useValue: { nodeById: (id: string) => nodes[id] ?? null } }],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    nodes = {};
    expect(openTooltips()).toHaveLength(0);
  });

  function query(selector: string): HTMLElement {
    const el = fixture.nativeElement.querySelector(selector) as HTMLElement | null;
    expect(el, `expected ${selector} to render`).toBeTruthy();
    return el as HTMLElement;
  }

  function hover(el: HTMLElement): void {
    el.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
  }

  // Gate 6: this button's `title` was replaced with an `aria-label` alone,
  // leaving a bare glyph with no hover hint on a session-ending action.
  it('gives Terminate both a hover disclosure and an accessible name', () => {
    const terminate = query('.action-btn.terminate');
    expect(terminate.getAttribute('aria-label')).toBeTruthy();

    hover(terminate);
    const open = openTooltips();
    expect(open).toHaveLength(1);
    expect(open[0]?.textContent?.trim()).not.toBe('');
  });

  it('names the leading indicator rather than relying on colour alone', () => {
    const indicator = query('.leading-indicator');
    expect(indicator.getAttribute('role')).toBe('img');
    expect(indicator.getAttribute('aria-label')).toContain('Claude');
  });

  // Gate 7: the attention dot sat INSIDE the leading indicator with its own
  // tooltip, and `mouseenter` fires on an element and every ancestor, so two
  // overlapping popups opened. Gate 9 then pointed out an earlier version of
  // this test dispatched `mouseenter` at the dot and asserted one tooltip —
  // which passes trivially now that the dot has no listener at all. Assert the
  // two things that are actually load-bearing instead.
  it('leaves the status dot as decoration with no tooltip of its own', () => {
    fixture.componentInstance.instance.set(makeInstance({ status: 'waiting_for_input' }));
    fixture.detectChanges();

    const dot = query('.attention-overlay-dot');
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(dot.getAttribute('aria-label')).toBeNull();
    // `aria-describedby` is what the directive stamps on a host it manages.
    hover(dot);
    expect(openTooltips()).toHaveLength(0);
  });

  it('shows exactly one tooltip when hovering the indicator that contains the dot', () => {
    fixture.componentInstance.instance.set(makeInstance({ status: 'waiting_for_input' }));
    fixture.detectChanges();

    hover(query('.leading-indicator'));
    expect(openTooltips()).toHaveLength(1);
  });

  // The dots carry no tooltip of their own now, so the indicator's combined
  // label must still say what state the row is in — otherwise de-nesting them
  // silently deleted the disclosure rather than moving it.
  it('folds the attention state into the indicator label', () => {
    fixture.componentInstance.instance.set(makeInstance({ status: 'waiting_for_input' }));
    fixture.detectChanges();
    expect(query('.leading-indicator').getAttribute('aria-label')).not.toBe('Claude');
  });

  it('folds the hibernated state into the indicator label', () => {
    fixture.componentInstance.instance.set(makeInstance({ status: 'hibernated' }));
    fixture.detectChanges();
    expect(query('.leading-indicator').getAttribute('aria-label')).toContain('hibernated');
  });

  // Gate 12: the badge showed the node NAME whether the node was healthy or
  // disconnected. "Session may be interrupted" was carried by an amber class
  // and a hover tooltip — colour alone for a sighted user, and nothing at all
  // for anyone who cannot hover a non-focusable span. There was no test at all.
  describe('remote-node badge', () => {
    function renderOnNode(connected: boolean): HTMLElement {
      nodes = { 'node-1': { name: 'windows-pc', status: connected ? 'connected' : 'offline', connected } };
      fixture.componentInstance.instance.set(
        makeInstance({ executionLocation: { type: 'remote', nodeId: 'node-1' } } as Partial<Instance>),
      );
      fixture.detectChanges();
      return query('.remote-badge');
    }

    it('says the node is offline in its visible text, not only in colour', () => {
      expect(renderOnNode(false).textContent).toContain('offline');
    });

    it('does not label a healthy node as offline', () => {
      const badge = renderOnNode(true);
      expect(badge.textContent).toContain('windows-pc');
      expect(badge.textContent).not.toContain('offline');
    });

    it('still explains the consequence on hover', () => {
      hover(renderOnNode(false));
      expect(openTooltips()[0]?.textContent).toContain('session may be interrupted');
    });
  });

  /**
   * Gate 14: `error` status was an 8%-opacity red row background and `yoloMode`
   * a 14%-opacity inset border, with neither named in text, aria, or a tooltip
   * anywhere in the row. Colour alone (WCAG 1.4.1) for an errored session, and
   * for auto-approve — a mode in which tool calls run without asking.
   *
   * The tooltip allowlist guard could not see either: neither element carries a
   * tooltip, which is the guard's documented blind spot.
   */
  describe('states that were previously colour-only', () => {
    function row(): HTMLElement {
      return query('.instance-row');
    }

    it('names an errored instance in the row accessible name', () => {
      fixture.componentInstance.instance.set(makeInstance({ status: 'error' }));
      fixture.detectChanges();
      expect(row().getAttribute('aria-label')).toContain('error');
    });

    it('names auto-approve mode in the row accessible name', () => {
      fixture.componentInstance.instance.set(makeInstance({ yoloMode: true } as Partial<Instance>));
      fixture.detectChanges();
      expect(row().getAttribute('aria-label')).toContain('auto-approve');
    });

    it('names both when an auto-approve instance errors', () => {
      fixture.componentInstance.instance.set(
        makeInstance({ status: 'error', yoloMode: true } as Partial<Instance>),
      );
      fixture.detectChanges();
      const label = row().getAttribute('aria-label') ?? '';
      expect(label).toContain('error');
      expect(label).toContain('auto-approve');
    });

    it('says neither on an ordinary idle instance', () => {
      const label = row().getAttribute('aria-label') ?? '';
      expect(label).toContain('Select instance');
      expect(label).not.toContain('error');
      expect(label).not.toContain('auto-approve');
    });

    it('also names the error on the leading indicator, which drives its tooltip', () => {
      fixture.componentInstance.instance.set(makeInstance({ status: 'error' }));
      fixture.detectChanges();
      expect(query('.leading-indicator').getAttribute('aria-label')).toContain('error');
    });
  });
});
