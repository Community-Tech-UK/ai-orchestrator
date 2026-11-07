import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../../core/state/instance.store';
import { SessionFactsComponent } from './session-facts.component';

describe('session facts', () => {
  it('computes nothing while closed, and reads the transcript once it is opened', () => {
    const getInstance = vi.fn(() => ({ outputBuffer: [] }));
    TestBed.configureTestingModule({ providers: [{ provide: InstanceStore, useValue: { getInstance } }] });
    const fixture = TestBed.createComponent(SessionFactsComponent);
    fixture.componentRef.setInput('instanceId', 'one');
    fixture.detectChanges();
    expect(getInstance).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('section')).toBeNull();
    const details = fixture.nativeElement.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
    expect(getInstance).toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('section')).not.toBeNull();
    TestBed.resetTestingModule();
  });
});
