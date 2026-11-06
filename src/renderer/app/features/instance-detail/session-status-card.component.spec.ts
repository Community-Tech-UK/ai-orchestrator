import { Component, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  describeInstanceStatus,
  presentInstanceStatus,
} from '../../../../shared/attention/instance-status-presentation';
import { USAGE_UNSUPPORTED_TEXT } from '../../../../shared/usage-insight/usage-cause-copy';
import type { Instance } from '../../core/state/instance.store';
import { StatusIndicatorComponent } from '../instance-list/status-indicator.component';
import { SessionStatusCardComponent } from './session-status-card.component';

@Component({
  selector: 'app-usage-where-went-card',
  standalone: true,
  template: '<div data-testid="usage-card" [attr.data-instance]="instanceId()"></div>',
})
class StubUsageCard {
  readonly instanceId = input<string | null>(null);
}

function session(overrides: Record<string, unknown> = {}): Instance {
  return { id: 'inst-1', provider: 'claude', status: 'idle', ...overrides } as unknown as Instance;
}

/** The sentence the card builds from the shared presenter's lowercase fragment. */
function sentenceFor(detail: string): string {
  return `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`;
}

describe('SessionStatusCardComponent', () => {
  let fixture: ComponentFixture<SessionStatusCardComponent>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.overrideComponent(SessionStatusCardComponent, {
      set: { imports: [StatusIndicatorComponent, StubUsageCard] },
    });
  });

  function render(instance: Instance): HTMLElement {
    fixture = TestBed.createComponent(SessionStatusCardComponent);
    fixture.componentRef.setInput('instance', instance);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const toggle = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('button.ssc-toggle')!;
  const panel = (root: HTMLElement) => root.querySelector('[data-testid="session-status-panel"]');
  const usageCard = (root: HTMLElement) => root.querySelector('[data-testid="usage-card"]');
  const open = (root: HTMLElement) => { toggle(root).click(); fixture.detectChanges(); };
  const statusLabel = (root: HTMLElement) => root.querySelector('.status-label')?.textContent?.trim();
  const sentence = (root: HTMLElement) => root.querySelector('[data-testid="session-status-sentence"]')?.textContent?.trim();

  describe('closed', () => {
    it('is closed to begin with, and has not asked for anything', () => {
      const root = render(session());
      expect(toggle(root).textContent).toContain('Status and usage');
      expect(toggle(root).getAttribute('aria-expanded')).toBe('false');
      expect(panel(root)).toBeNull();
      expect(usageCard(root)).toBeNull();
    });

    it('does not point at a panel that is not on the page', () => {
      expect(toggle(render(session())).hasAttribute('aria-controls')).toBe(false);
    });
  });

  describe('open', () => {
    it('shows the status in the shared words, with the shared sentence for it', () => {
      const root = render(session({ status: 'waiting_for_input' }));
      open(root);
      const presented = presentInstanceStatus('waiting_for_input');
      expect(statusLabel(root)).toBe(presented.label);
      expect(presented.label).toBe('Needs your answer');
      expect(sentence(root)).toBe(sentenceFor(presented.detail));
    });

    it('adds no sentence when the status label says it all', () => {
      const root = render(session({ status: 'idle' }));
      open(root);
      expect(statusLabel(root)).toBe('Ready');
      expect(sentence(root)).toBeUndefined();
    });

    it('explains a wait the same way the status dot does', () => {
      const waitReason = { kind: 'quota-park', provider: 'claude', resumeAt: 999 };
      const root = render(session({ status: 'idle', waitReason }));
      open(root);
      const presented = presentInstanceStatus('idle', waitReason as never);
      expect(statusLabel(root)).toBe(presented.label);
      expect(sentence(root)).toBe(sentenceFor(presented.detail));
      expect(root.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(describeInstanceStatus(presented));
    });

    it('counts background work the same way the status dot does', () => {
      const root = render(session({ status: 'idle', backgroundWork: { count: 2, since: 1 } }));
      open(root);
      const presented = presentInstanceStatus('idle', null, { backgroundWorkCount: 2 });
      expect(presented.label).toBe('Working');
      expect(statusLabel(root)).toBe('Working');
      expect(sentence(root)).toBe(sentenceFor(presented.detail));
    });

    it('follows the status while it is open', () => {
      const root = render(session({ status: 'idle' }));
      open(root);
      fixture.componentRef.setInput('instance', session({ status: 'waiting_for_permission' }));
      fixture.detectChanges();
      expect(statusLabel(root)).toBe('Needs your OK');
    });

    it('is a labelled region that the button controls, and says it is expanded', () => {
      const root = render(session());
      open(root);
      expect(toggle(root).getAttribute('aria-expanded')).toBe('true');
      const region = panel(root)!;
      expect(region.getAttribute('aria-label')).toBe('Session status and usage');
      expect(toggle(root).getAttribute('aria-controls')).toBe(region.id);
      expect(region.id.length).toBeGreaterThan(0);
    });

    it('closes again', () => {
      const root = render(session());
      open(root);
      open(root);
      expect(panel(root)).toBeNull();
      expect(toggle(root).getAttribute('aria-expanded')).toBe('false');
    });

    it('uses no native title attributes', () => {
      const root = render(session());
      open(root);
      expect(root.querySelectorAll('[title]')).toHaveLength(0);
    });
  });

  describe('usage', () => {
    it('shows where this session\'s usage went, for a Claude session, only once opened', () => {
      const root = render(session({ id: 'inst-claude' }));
      expect(usageCard(root)).toBeNull();
      open(root);
      expect(usageCard(root)?.getAttribute('data-instance')).toBe('inst-claude');
    });

    it('stops showing it, so it stops reading, when closed', () => {
      const root = render(session());
      open(root);
      open(root);
      expect(usageCard(root)).toBeNull();
    });

    it.each(['codex', 'gemini', 'copilot'])('does not ask for a %s session, and says why', (provider) => {
      const root = render(session({ provider }));
      open(root);
      expect(usageCard(root)).toBeNull();
      expect(root.querySelector('[data-testid="session-usage-unsupported"]')?.textContent?.trim())
        .toBe(USAGE_UNSUPPORTED_TEXT['not-claude']);
      // The status is still there.
      expect(statusLabel(root)).toBe('Ready');
    });
  });

  describe('changing session', () => {
    it('closes when another session is selected, and stays closed when the first comes back', () => {
      const root = render(session({ id: 'inst-a' }));
      open(root);
      expect(panel(root)).not.toBeNull();

      fixture.componentRef.setInput('instance', session({ id: 'inst-b' }));
      fixture.detectChanges();
      expect(panel(root)).toBeNull();
      expect(toggle(root).getAttribute('aria-expanded')).toBe('false');

      fixture.componentRef.setInput('instance', session({ id: 'inst-a' }));
      fixture.detectChanges();
      expect(panel(root)).toBeNull();
    });

    it('stays open while the same session updates', () => {
      const root = render(session({ id: 'inst-a', status: 'idle' }));
      open(root);
      fixture.componentRef.setInput('instance', session({ id: 'inst-a', status: 'busy' }));
      fixture.detectChanges();
      expect(panel(root)).not.toBeNull();
      expect(statusLabel(root)).toBe('Working');
    });
  });
});

describe('where the session view mounts the card', () => {
  const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
  const html = read('./instance-detail.component.html');
  const source = read('./instance-detail.component.ts');

  it('mounts it once, for the live session, between the inspector toggles and the user action requests', () => {
    expect(html.match(/<app-session-status-card\b/g)).toHaveLength(1);
    expect(html).toContain('<app-session-status-card [instance]="inst" />');
    const mounted = html.indexOf('<app-session-status-card');
    expect(mounted).toBeGreaterThan(html.indexOf('Inspector toggles'));
    expect(mounted).toBeLessThan(html.indexOf('<app-user-action-request'));
    // Inside the branch that has a live session (`inst`), not the history preview or the welcome screen.
    expect(mounted).toBeLessThan(html.indexOf('} @else if (historyPreview(); as preview)'));
  });

  it('imports it and lists it with the other components the view uses', () => {
    expect(source).toContain("import { SessionStatusCardComponent } from './session-status-card.component';");
    expect(source).toMatch(/imports: \[[^\]]*\bSessionStatusCardComponent\b[^\]]*\]/);
  });

  it('leaves the neighbours it sits between as they were', () => {
    expect(html).toContain('<app-user-action-request [instanceId]="inst.id" />');
    expect(html).toContain('<app-loop-control [chatId]="inst.id" />');
    expect(html).toContain('<app-input-panel');
  });
});
