import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { LoopDetailComponent } from './loop-detail.component';
import { LoopStore } from './loop.store';
import { PlanQueueComponent } from '../plan-queue/plan-queue.component';
import { PlanQueueStore } from '../plan-queue/plan-queue.store';

function button(element: HTMLElement, label: string): HTMLButtonElement {
  const found = [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
describe('phone destructive controls', () => {
  it('shows Stop confirmation, Keep going cancels, and confirming sends once', () => {
    const control = vi.fn().mockResolvedValue(true);
    const loops = { detail: signal({ run: { id: 'loop', status: 'running', iteration: 1 }, outstanding: [] }), error: signal(null), pendingId: signal(null), open: vi.fn(), control };
    TestBed.configureTestingModule({ providers: [{ provide: LoopStore, useValue: loops }, { provide: Router, useValue: { navigate: vi.fn() } }] });
    const fixture = TestBed.createComponent(LoopDetailComponent); fixture.componentRef.setInput('id', 'loop'); fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    button(element, 'Stop').click(); fixture.detectChanges();
    expect(control).not.toHaveBeenCalled(); expect(element.textContent).toContain('Stop this loop? Its work so far is kept.');
    button(element, 'Keep going').click(); fixture.detectChanges(); expect(element.textContent).not.toContain('Stop this loop?');
    button(element, 'Stop').click(); fixture.detectChanges(); button(element, 'Stop it').click(); fixture.detectChanges();
    expect(control).toHaveBeenCalledExactlyOnceWith('loop', 'stop');
  });
  it('binds Cancel confirmation to the selected run and prevents a second send', () => {
    const control = vi.fn().mockResolvedValue(true);
    const queue = { runs: signal([{ id: 'run', kind: 'plans', status: 'running', items: [] }]), error: signal(null), status: signal('ready'), pending: signal(false), control };
    TestBed.configureTestingModule({ providers: [{ provide: PlanQueueStore, useValue: queue }, { provide: Router, useValue: { navigate: vi.fn() } }] });
    const fixture = TestBed.createComponent(PlanQueueComponent); fixture.detectChanges(); const element = fixture.nativeElement as HTMLElement;
    button(element, 'Cancel').click(); fixture.detectChanges();
    expect(control).not.toHaveBeenCalled(); expect(element.textContent).toContain('Items not started are skipped for good.');
    button(element, 'Keep going').click(); fixture.detectChanges(); expect(element.textContent).not.toContain('Cancel the whole run?');
    button(element, 'Cancel').click(); fixture.detectChanges(); const confirm = button(element, 'Cancel the run'); confirm.click(); confirm.click(); fixture.detectChanges();
    expect(control).toHaveBeenCalledExactlyOnceWith('run', 'cancel');
  });
});
