import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalAiDiagnosticReport,
  LocalAiIncident,
  LocalAiRepairResult,
} from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { LocalAiIncidentPanelComponent } from './local-ai-incident-panel.component';

function incident(): LocalAiIncident {
  return {
    id: 'incident-1',
    targetId: 'target-1',
    state: 'open',
    severity: 'critical',
    failureCode: 'endpoint-timeout',
    affectedLayers: ['endpoint', 'inference'],
    affectedRoles: ['compression'],
    openedAt: 1_000,
    updatedAt: 2_000,
    fallbackCount: 3,
    knownCostUsd: 0.06,
    estimatedCostUsd: 0.02,
    unpricedDispatchCount: 0,
  };
}

function diagnosis(): LocalAiDiagnosticReport {
  return {
    targetId: 'target-1',
    checkedAt: 3_000,
    samples: [],
    recommendedActions: ['deep-check', 'validate-models', 'restart-ollama'],
  };
}

function repair(action: LocalAiRepairResult['action']): LocalAiRepairResult {
  return {
    targetId: 'target-1',
    action,
    outcome: 'guided',
    supported: true,
    attempted: false,
    recovered: false,
    message: 'Use the supported Ollama service controls, then run a deep check.',
    completedAt: 4_000,
  };
}

describe('LocalAiIncidentPanelComponent', () => {
  const store = {
    operationKey: vi.fn(() => null),
    operationError: vi.fn((): string | null => null),
    acknowledgeIncident: vi.fn(async () => undefined),
    diagnoseTarget: vi.fn(async () => diagnosis()),
    repairTarget: vi.fn<(
      targetId: string,
      action: LocalAiRepairResult['action'],
      mode: 'guided' | 'automatic',
    ) => Promise<LocalAiRepairResult | undefined>>(async (_targetId, action) => repair(action)),
    diagnosticFor: vi.fn(() => diagnosis()),
    repairFor: vi.fn(() => null),
  };
  let fixture: ComponentFixture<LocalAiIncidentPanelComponent>;

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [LocalAiIncidentPanelComponent],
      providers: [{ provide: LocalAiGuardStore, useValue: store }],
    });
    fixture = TestBed.createComponent(LocalAiIncidentPanelComponent);
    fixture.componentRef.setInput('incident', incident());
    fixture.componentRef.setInput('automaticRepairEnabled', false);
    fixture.detectChanges();
  });

  it('acknowledges, diagnoses, and exposes named guided recovery actions', async () => {
    click('Acknowledge');
    await fixture.whenStable();
    expect(store.acknowledgeIncident).toHaveBeenCalledWith('incident-1');

    click('Diagnose');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(store.diagnoseTarget).toHaveBeenCalledWith('target-1');
    expect(fixture.nativeElement.textContent).toContain('Deep check');
    expect(fixture.nativeElement.textContent).toContain('Validate models');
    expect(fixture.nativeElement.textContent).toContain('Restart Ollama');

    click('Show guided steps for Restart Ollama');
    await fixture.whenStable();
    expect(store.repairTarget).toHaveBeenCalledWith(
      'target-1',
      'restart-ollama',
      'guided',
    );
  });

  it('announces unsupported guided recovery without claiming guidance is ready', async () => {
    store.repairTarget.mockResolvedValueOnce({
      ...repair('restart-ollama'),
      outcome: 'unsupported',
      supported: false,
    });

    click('Show guided steps for Restart Ollama');
    await fixture.whenStable();
    fixture.detectChanges();

    const live = fixture.nativeElement.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live.textContent).toContain('Restart Ollama is not supported');
    expect(live.textContent).not.toContain('guidance ready');
  });

  it('keeps automatic repair opt-in and guards the dangerous restart action', async () => {
    expect(button('Restart Ollama automatically').disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain(
      'Enable automatic repair in target settings before this action can run.',
    );

    fixture.componentRef.setInput('automaticRepairEnabled', true);
    fixture.detectChanges();
    click('Restart Ollama automatically');
    fixture.detectChanges();
    expect(store.repairTarget).not.toHaveBeenCalledWith(
      'target-1',
      'restart-ollama',
      'automatic',
    );
    expect(fixture.nativeElement.querySelector('[role="alertdialog"]')).not.toBeNull();

    click('Confirm automatic restart');
    await fixture.whenStable();
    expect(store.repairTarget).toHaveBeenCalledWith(
      'target-1',
      'restart-ollama',
      'automatic',
    );
  });

  it('announces outcomes, redacts raw errors, and restores focus after confirmation', async () => {
    store.operationError.mockReturnValue('http://user:secret@host/private');
    fixture.componentRef.setInput('automaticRepairEnabled', true);
    fixture.detectChanges();
    click('Restart Ollama automatically');
    fixture.detectChanges();
    click('Cancel');
    await fixture.whenStable();

    expect(document.activeElement).toBe(button('Restart Ollama automatically'));
    expect(fixture.nativeElement.textContent).toContain(
      'The recovery action could not be completed. Try again.',
    );
    expect(fixture.nativeElement.textContent).not.toContain('user:secret');
    const live = fixture.nativeElement.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live).not.toBeNull();
  });

  it('announces an automatic restart transport failure without claiming completion', async () => {
    store.repairTarget.mockResolvedValueOnce(undefined);
    fixture.componentRef.setInput('automaticRepairEnabled', true);
    fixture.detectChanges();
    click('Restart Ollama automatically');
    click('Confirm automatic restart');
    await fixture.whenStable();
    fixture.detectChanges();

    const live = fixture.nativeElement.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live.textContent).toContain('Automatic restart failed');
    expect(live.textContent).not.toContain('completed');
    expect(document.activeElement).toBe(button('Restart Ollama automatically'));
  });

  it.each([
    ['unsupported', false, false, false, 'Automatic restart is not supported'],
    ['not-attempted', true, false, false, 'Automatic restart did not run'],
    ['execution-failed', true, true, false, 'Automatic restart failed'],
    [
      'completed-not-recovered',
      true,
      true,
      false,
      'Automatic restart ran, but health did not recover',
    ],
    ['recovered', true, true, true, 'Automatic restart completed and health recovered'],
  ] as const)('announces the explicit %s automatic repair outcome', async (
    outcome,
    supported,
    attempted,
    recovered,
    expected,
  ) => {
    store.repairTarget.mockResolvedValueOnce({
      ...repair('restart-ollama'),
      outcome,
      supported,
      attempted,
      recovered,
    });
    fixture.componentRef.setInput('automaticRepairEnabled', true);
    fixture.detectChanges();
    click('Restart Ollama automatically');
    click('Confirm automatic restart');
    await fixture.whenStable();
    fixture.detectChanges();

    const live = fixture.nativeElement.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live.textContent).toContain(expected);
  });

  it('uses incident-scoped dialog IDs and traps forward tab navigation', () => {
    fixture.componentRef.setInput('automaticRepairEnabled', true);
    fixture.detectChanges();
    click('Restart Ollama automatically');
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-labelledby')).toBe('automatic-restart-title-incident-1');
    expect(dialog.getAttribute('aria-describedby')).toBe(
      'automatic-restart-description-incident-1',
    );
    const dialogButtons = Array.from(
      dialog.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
    dialogButtons.at(-1)?.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(dialogButtons[0]);
  });

  function button(label: string): HTMLButtonElement {
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
    const match = buttons.find((candidate) => candidate.textContent?.trim() === label);
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
  }

  function click(label: string): void {
    button(label).click();
    fixture.detectChanges();
  }
});
