import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanUpdateCardComponent } from './plan-update-card.component';
import { parseCopilotPlanUpdate } from './copilot-plan-update';
import { ExpansionStateService } from './expansion-state.service';

describe('plan update availability hint', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('explains an empty plan and permits expansion when the agent advertises steps', () => {
    const fixture = TestBed.createComponent(PlanUpdateCardComponent);
    fixture.componentRef.setInput('instanceId', 'session');
    fixture.componentRef.setInput('itemId', 'plan');
    fixture.componentRef.setInput('timestamp', 1);
    fixture.componentRef.setInput('plan', parseCopilotPlanUpdate({ type: 'system', content: 'Plan: no entries advertised.' }));
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    const matches = button.matches.bind(button);
    vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    button.focus();
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('has not listed any plan steps');
    button.click();
    expect(TestBed.inject(ExpansionStateService).isExpanded('session', 'plan')).toBe(false);

    fixture.componentRef.setInput('plan', parseCopilotPlanUpdate({ type: 'system', content: 'Plan:\n- Read the files (pending)' }));
    fixture.detectChanges();
    expect(button.getAttribute('aria-disabled')).toBeNull();
    button.click();
    fixture.detectChanges();
    expect(TestBed.inject(ExpansionStateService).isExpanded('session', 'plan')).toBe(true);
    expect(fixture.nativeElement.querySelector('.plan-card__body')?.textContent).toContain('Read the files');
    fixture.destroy();
  });
});
