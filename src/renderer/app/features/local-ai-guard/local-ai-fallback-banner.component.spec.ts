import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalAiFallbackRequest,
  LocalAiFallbackResolution,
  LocalAiRoutingEvent,
} from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { LocalAiFallbackBannerComponent } from './local-ai-fallback-banner.component';
import { LocalAiStatusChipComponent } from './local-ai-status-chip.component';

@Component({
  standalone: true,
  imports: [LocalAiFallbackBannerComponent, LocalAiStatusChipComponent],
  template: `
    <app-local-ai-status-chip />
    <app-local-ai-fallback-banner />
  `,
})
class LocalAiFallbackShellHostComponent {}

function request(
  id: string,
  createdAt: number,
  overrides: Partial<LocalAiFallbackRequest> = {},
): LocalAiFallbackRequest {
  return {
    id,
    routingEventId: `event-${id}`,
    incidentId: 'incident-1',
    slot: 'memoryDistillation',
    status: 'pending',
    estimatedInputTokens: 1_250,
    estimatedCostUsd: 0.0375,
    createdAt,
    expiresAt: createdAt + 60_000,
    ...overrides,
  };
}

function notification(
  id: string,
  overrides: Partial<LocalAiRoutingEvent> = {},
): LocalAiRoutingEvent {
  return {
    id,
    slot: 'compression',
    intendedRoute: 'local',
    actualRoute: 'frontier',
    policy: 'notify-and-allow',
    disposition: 'allowed',
    decisionReason: 'policy',
    inputTokens: 500,
    outputTokens: 100,
    estimatedCostUsd: 0.0125,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('LocalAiFallbackBannerComponent', () => {
  const pendingFallbacks = signal<LocalAiFallbackRequest[]>([]);
  const resolvingFallbackId = signal<string | null>(null);
  const error = signal<string | null>(null);
  const isInitialized = signal(true);
  const hasAuthoritativeSnapshot = signal(true);
  const aggregate = signal({
    state: 'healthy' as const,
    enrolled: 1,
    healthy: 1,
    degraded: 0,
    unavailable: 0,
    paused: 0,
  });
  const resolveFallback = vi.fn(
    async (_id: string, _resolution: LocalAiFallbackResolution) => undefined,
  );
  const fallbackNotifications = signal<LocalAiRoutingEvent[]>([]);
  const dismissFallbackNotification = vi.fn((eventId: string) => {
    fallbackNotifications.update((events) => events.filter((event) => event.id !== eventId));
  });
  const store = {
    pendingFallbacks: pendingFallbacks.asReadonly(),
    resolvingFallbackId: resolvingFallbackId.asReadonly(),
    error: error.asReadonly(),
    isInitialized: isInitialized.asReadonly(),
    hasAuthoritativeSnapshot: hasAuthoritativeSnapshot.asReadonly(),
    aggregate: aggregate.asReadonly(),
    resolveFallback,
    fallbackNotifications: fallbackNotifications.asReadonly(),
    dismissFallbackNotification,
  };
  const router = { navigateByUrl: vi.fn(async () => true) };
  let fixture: ComponentFixture<LocalAiFallbackBannerComponent>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    pendingFallbacks.set([]);
    resolvingFallbackId.set(null);
    error.set(null);
    fallbackNotifications.set([]);
    TestBed.configureTestingModule({
      imports: [LocalAiFallbackBannerComponent],
      providers: [
        { provide: LocalAiGuardStore, useValue: store },
        { provide: Router, useValue: router },
      ],
    });
    fixture = TestBed.createComponent(LocalAiFallbackBannerComponent);
  });

  it('shows only the deterministically oldest pending request with slot, token, and cost impact', () => {
    pendingFallbacks.set([
      request('same-time-z', 1_000),
      request('newer', 2_000),
      request('same-time-a', 1_000),
    ]);
    fixture.detectChanges();

    const banner = fixture.nativeElement.querySelector('.local-ai-fallback-banner') as HTMLElement;
    expect(banner.textContent).toContain('Paid fallback needs a decision');
    expect(banner.textContent).toContain('Memory distillation');
    expect(banner.textContent).toContain('1,250 input tokens');
    expect(banner.textContent).toContain('$0.0375 estimated');
    expect(banner.getAttribute('data-request-id')).toBe('same-time-a');
    expect(fixture.nativeElement.querySelectorAll('.local-ai-fallback-banner')).toHaveLength(1);
  });

  it('uses explicit safe unknown states instead of inventing token or cost values', () => {
    pendingFallbacks.set([
      request('unknown', 1_000, {
        estimatedInputTokens: 0,
        estimatedCostUsd: undefined,
      }),
    ]);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Input tokens unknown');
    expect(text).toContain('Cost unknown');
    expect(text).not.toContain('$0.0000');
  });

  it.each([
    ['Allow once', 'allow-once'],
    ['Allow for incident', 'allow-incident'],
    ['Keep local', 'defer'],
    ['Block', 'block'],
  ] as const)('sends the %s decision for the oldest request', async (label, resolution) => {
    pendingFallbacks.set([request('oldest', 1_000)]);
    fixture.detectChanges();

    button(label).click();
    await fixture.whenStable();

    expect(resolveFallback).toHaveBeenCalledExactlyOnceWith('oldest', resolution);
  });

  it('disables every decision while the store resolves a fallback', () => {
    pendingFallbacks.set([request('oldest', 1_000)]);
    resolvingFallbackId.set('oldest');
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
    expect(Array.from(buttons).every((candidate) => candidate.disabled)).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Saving decision…');
  });

  it('returns focus to the same action on failure and to that action for the next request on success', async () => {
    const first = request('first', 1_000);
    const second = request('second', 2_000);
    pendingFallbacks.set([first, second]);
    resolveFallback.mockImplementationOnce(async () => {
      error.set('Fallback decision could not be saved. Try again.');
    });
    fixture.detectChanges();
    button('Keep local').click();
    await fixture.whenStable();
    fixture.detectChanges();
    await Promise.resolve();
    expect(document.activeElement).toBe(button('Keep local'));

    resolveFallback.mockImplementationOnce(async () => {
      error.set(null);
      pendingFallbacks.set([second]);
    });
    button('Allow once').click();
    await fixture.whenStable();
    fixture.detectChanges();
    await Promise.resolve();
    expect(document.activeElement).toBe(button('Allow once'));
  });

  it('announces only meaningful changes and does not rewrite the live region for unchanged state', () => {
    const oldest = request('oldest', 1_000);
    pendingFallbacks.set([oldest]);
    fixture.detectChanges();
    const live = fixture.nativeElement.querySelector('[data-testid="local-ai-fallback-live"]');
    const firstText = live.textContent;
    const firstNode = live.firstChild;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(firstText).toBe(
      'New paid fallback request 1 for Memory distillation. '
      + '1,250 input tokens. $0.0375 estimated.',
    );

    pendingFallbacks.set([{ ...oldest }]);
    fixture.detectChanges();

    expect(live.textContent).toBe(firstText);
    expect(live.firstChild).toBe(firstNode);

    pendingFallbacks.set([request('next', 2_000)]);
    fixture.detectChanges();
    expect(live.textContent).toBe(
      'New paid fallback request 2 for Memory distillation. '
      + '1,250 input tokens. $0.0375 estimated.',
    );

    pendingFallbacks.set([]);
    fixture.detectChanges();
    expect(live.textContent).toBe('Paid fallback queue cleared.');
  });

  it('focuses the status chip after successful resolution empties the queue', async () => {
    pendingFallbacks.set([request('only-request', 1_000)]);
    resolveFallback.mockImplementationOnce(async () => {
      pendingFallbacks.set([]);
    });
    const shell = TestBed.createComponent(LocalAiFallbackShellHostComponent);
    document.body.appendChild(shell.nativeElement);
    shell.detectChanges();

    const allow = Array.from(
      shell.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((candidate) => candidate.textContent?.trim() === 'Allow once');
    allow?.click();
    await shell.whenStable();
    shell.detectChanges();
    await shell.whenStable();

    expect(shell.nativeElement.querySelector('.local-ai-fallback-banner')).toBeNull();
    const statusChip = shell.nativeElement.querySelector(
      '[data-testid="local-ai-status-chip"]',
    );
    expect(statusChip).not.toBeNull();
    expect(document.activeElement).toBe(statusChip);
    shell.destroy();
    shell.nativeElement.remove();
  });

  it('shows only fixed privacy-safe resolution errors', () => {
    pendingFallbacks.set([request('oldest', 1_000)]);
    error.set('Fallback decision could not be saved. Try again.');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Fallback decision could not be saved. Try again.',
    );
    expect(fixture.nativeElement.textContent).not.toContain('/Users/');
  });

  it('LT-189: renders a passive notify-and-allow notification alongside the require-confirmation banner', () => {
    pendingFallbacks.set([request('oldest', 1_000)]);
    fallbackNotifications.set([notification('event-1')]);
    fixture.detectChanges();

    // Both surfaces render at once — the notification is not blocked or
    // hidden by an unrelated pending confirmation.
    expect(fixture.nativeElement.querySelector('.local-ai-fallback-banner')).not.toBeNull();
    const row = fixture.nativeElement.querySelector(
      '.fallback-notification[data-event-id="event-1"]',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('Paid fallback happened automatically');
    expect(row.textContent).toContain('Compression');
    expect(row.textContent).toContain('$0.0125 estimated');
    // Informational only — no accept/reject controls, only a dismiss.
    expect(row.querySelectorAll('button')).toHaveLength(1);
    expect(row.querySelector('button')?.textContent?.trim()).toBe('Dismiss');
  });

  it('LT-189: shows "Cost unknown" for an unpriced notify-and-allow event rather than a confident $0', () => {
    fallbackNotifications.set([notification('event-1', { estimatedCostUsd: undefined })]);
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector(
      '.fallback-notification[data-event-id="event-1"]',
    ) as HTMLElement;
    expect(row.textContent).toContain('Cost unknown');
    expect(row.textContent).not.toContain('$0.0000');
  });

  it('groups a same-slot burst into one notification with an aggregate cost', () => {
    fallbackNotifications.set([
      notification('event-1', { slot: 'titleGeneration', createdAt: 1_000, estimatedCostUsd: 0.001 }),
      notification('event-2', { slot: 'titleGeneration', createdAt: 2_000, estimatedCostUsd: 0.002 }),
      notification('event-3', { slot: 'titleGeneration', createdAt: 3_000, knownCostUsd: 0.003 }),
    ]);
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.fallback-notification');
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    expect(row.getAttribute('data-event-id')).toBeNull();
    expect(row.getAttribute('data-event-ids')).toBe('event-3,event-2,event-1');
    expect(row.textContent).toContain('3 paid fallbacks happened automatically');
    expect(row.textContent).toContain('Title generation');
    expect(row.textContent).toContain('$0.0060 estimated');
    expect(row.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Dismiss 3 paid fallback notifications',
    );
  });

  it('dismissing a grouped notification dismisses every event in the burst', () => {
    fallbackNotifications.set([
      notification('event-1', { createdAt: 1_000 }),
      notification('event-2', { createdAt: 2_000 }),
      notification('event-3', { createdAt: 3_000 }),
    ]);
    fixture.detectChanges();

    const dismiss = fixture.nativeElement.querySelector(
      '.fallback-notification[data-event-ids="event-3,event-2,event-1"] button',
    ) as HTMLButtonElement;
    dismiss.click();
    fixture.detectChanges();

    expect(dismissFallbackNotification.mock.calls).toEqual([
      ['event-3'],
      ['event-2'],
      ['event-1'],
    ]);
    expect(fixture.nativeElement.querySelector('.local-ai-fallback-notifications')).toBeNull();
  });

  it('LT-189: dismissing one notification removes only that one from the DOM', () => {
    fallbackNotifications.set([
      notification('event-1'),
      notification('event-2', { createdAt: 7_000 }),
    ]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.fallback-notification')).toHaveLength(2);

    const firstDismiss = fixture.nativeElement
      .querySelector('.fallback-notification[data-event-id="event-1"] button') as HTMLButtonElement;
    firstDismiss.click();
    fixture.detectChanges();

    expect(dismissFallbackNotification).toHaveBeenCalledExactlyOnceWith('event-1');
    expect(fixture.nativeElement.querySelector(
      '.fallback-notification[data-event-id="event-1"]',
    )).toBeNull();
    expect(fixture.nativeElement.querySelector(
      '.fallback-notification[data-event-id="event-2"]',
    )).not.toBeNull();
  });

  it('LT-189: renders nothing for the notification section when there are no undismissed notifications', () => {
    fallbackNotifications.set([]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.local-ai-fallback-notifications')).toBeNull();
  });

  function button(label: string): HTMLButtonElement {
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
    const match = buttons.find((candidate) => candidate.textContent?.trim() === label);
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
  }
});
