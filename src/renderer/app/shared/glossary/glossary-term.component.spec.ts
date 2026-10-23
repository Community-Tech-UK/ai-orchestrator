import { Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlossaryTermComponent } from './glossary-term.component';
import { glossaryPlain, type GlossaryTermId } from './glossary';
import { HelpDrawerService } from '../help/help-drawer.service';

@Component({ standalone: true, imports: [GlossaryTermComponent], template: `<div tabindex="0" (click)="parentClick()" (keydown.enter)="parentClick()"><app-term term="worktree">Worktrees</app-term><app-term term="tokens" /></div>` })
class Host { parentClick = vi.fn(); }

// @ts-expect-error Unknown glossary ids must fail template input type checking.
const invalidTerm: GlossaryTermId = 'not-a-term';
void invalidTerm;

describe('GlossaryTermComponent', () => {
  let fixture: ComponentFixture<Host>;
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });
  afterEach(() => fixture.destroy());
  it('renders projection and falls back to the label when empty', () => {
    const buttons = fixture.nativeElement.querySelectorAll('app-term button');
    expect(buttons[0].textContent).toBe('Worktrees');
    expect(buttons[1].textContent).toBe('Tokens');
    expect(buttons[0].getAttribute('aria-haspopup')).toBe('dialog');
  });
  it('opens the definition immediately on keyboard-visible focus with its description', () => {
    const button: HTMLElement = fixture.nativeElement.querySelector('button');
    const original = button.matches.bind(button);
    vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible' || original(selector));
    button.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    const tooltip = document.getElementById(button.getAttribute('aria-describedby')!);
    expect(tooltip?.textContent?.trim()).toBe(`${glossaryPlain('worktree')} Select for more.`);
  });
  it('opens the Words topic at the term without activating its parent', () => {
    const drawer = TestBed.inject(HelpDrawerService);
    fixture.nativeElement.querySelector('button').click();
    expect(drawer.target()).toEqual({ topic: 'glossary', anchor: 'worktree' });
    expect(fixture.componentInstance.parentClick).not.toHaveBeenCalled();
  });
});
