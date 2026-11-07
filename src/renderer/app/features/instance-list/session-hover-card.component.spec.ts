import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionHoverCardComponent } from './session-hover-card.component';

describe('SessionHoverCardComponent', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('shows the name, status, pending text and the real step when supplied', () => {
    const fixture = TestBed.createComponent(SessionHoverCardComponent);
    fixture.componentRef.setInput('name', 'Fix login'); fixture.componentRef.setInput('status', 'Waiting for you');
    fixture.componentRef.setInput('pendingText', 'May I run Bash?'); fixture.componentRef.setInput('step', 'Step 2 of 5: Implement');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('May I run Bash?');
    expect(fixture.nativeElement.textContent).toContain('Step 2 of 5: Implement');
    fixture.componentRef.setInput('step', null); fixture.detectChanges(); expect(fixture.nativeElement.textContent).not.toContain('Step');
  });
});
