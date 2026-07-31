import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunReadinessBannerComponent } from './run-readiness-banner.component';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import type { RunReadinessReason } from './run-readiness';

const blockingReason: RunReadinessReason = {
  id: 'provider-none-available',
  severity: 'blocking',
  message: 'No supported provider CLI is currently available.',
  action: { label: 'Open Doctor', commandId: 'app.open-doctor' },
};

const warningReason: RunReadinessReason = {
  id: 'provider-degraded-codex',
  severity: 'warning',
  message: 'Codex CLI is not available on PATH.',
  action: { label: 'Open Doctor', commandId: 'app.open-doctor' },
};

describe('RunReadinessBannerComponent', () => {
  let fixture: ComponentFixture<RunReadinessBannerComponent>;
  const dispatch = vi.fn().mockResolvedValue(true);

  beforeEach(async () => {
    dispatch.mockClear();
    await TestBed.configureTestingModule({
      imports: [RunReadinessBannerComponent],
      providers: [{ provide: ActionDispatchService, useValue: { dispatch } }],
    }).compileComponents();
    fixture = TestBed.createComponent(RunReadinessBannerComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1');
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('renders nothing when the reasons list is empty', () => {
    fixture.componentRef.setInput('reasons', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.run-readiness-banner')).toBeNull();
  });

  it('renders a blocking reason with role="alert" and one primary action, no dismiss control', () => {
    fixture.componentRef.setInput('reasons', [blockingReason]);
    fixture.detectChanges();

    const item = fixture.nativeElement.querySelector('.run-readiness-item') as HTMLElement;
    expect(item).toBeTruthy();
    expect(item.getAttribute('role')).toBe('alert');
    expect(item.textContent).toContain('No supported provider CLI is currently available.');

    const actionButtons = item.querySelectorAll('.run-readiness-btn:not(.run-readiness-btn--secondary)');
    expect(actionButtons).toHaveLength(1);
    expect((actionButtons[0] as HTMLElement).textContent?.trim()).toBe('Open Doctor');
    expect(item.querySelector('.run-readiness-btn--secondary')).toBeNull();
  });

  it('renders a non-blocking reason with role="status" and a dismiss control', () => {
    fixture.componentRef.setInput('reasons', [warningReason]);
    fixture.detectChanges();

    const item = fixture.nativeElement.querySelector('.run-readiness-item') as HTMLElement;
    expect(item.getAttribute('role')).toBe('status');
    expect(item.querySelector('.run-readiness-btn--secondary')).toBeTruthy();
  });

  it('dispatches the reason\'s command id through ActionDispatchService when its action is clicked', () => {
    fixture.componentRef.setInput('reasons', [blockingReason]);
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.run-readiness-btn') as HTMLButtonElement).click();

    expect(dispatch).toHaveBeenCalledWith('app.open-doctor');
  });

  it('dismisses a non-blocking reason for this instance only, and it stays dismissed until it recurs', () => {
    fixture.componentRef.setInput('reasons', [warningReason]);
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.run-readiness-btn--secondary') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.run-readiness-banner')).toBeNull();

    // A different instance is unaffected by another instance's dismissal.
    fixture.componentRef.setInput('instanceId', 'inst-2');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.run-readiness-item')).toBeTruthy();
  });

  it('never lets a dismissal hide a blocking reason', () => {
    fixture.componentRef.setInput('reasons', [blockingReason]);
    fixture.detectChanges();

    // Blocking reasons render no dismiss control, but even a direct call
    // must not be able to hide the reason Send is disabled for.
    fixture.componentInstance.onDismiss(blockingReason.id);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.run-readiness-item')).toBeTruthy();
  });

  it('renders one item per reason, blocking and warning together, each with its own role', () => {
    fixture.componentRef.setInput('reasons', [blockingReason, warningReason]);
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('.run-readiness-item');
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute('role')).toBe('alert');
    expect(items[1].getAttribute('role')).toBe('status');
  });
});
