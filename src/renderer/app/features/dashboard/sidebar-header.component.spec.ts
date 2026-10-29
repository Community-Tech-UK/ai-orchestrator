import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarHeaderComponent } from './sidebar-header.component';
import { KeybindingService } from '../../core/services/keybinding.service';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';

await resolveComponentResources(() => Promise.resolve(''));
describe('Sidebar header hints', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('retains the distinct names and hints, and reads the new-session shortcut live', () => {
    TestBed.configureTestingModule({ imports: [SidebarHeaderComponent] });
    const fixture = TestBed.createComponent(SidebarHeaderComponent); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
    const controls = fixture.debugElement.queryAll(By.css('button'));
    expect(controls.map(control => control.nativeElement.getAttribute('aria-label'))).toEqual(['Start a new chat', 'Create a new session']);
    expect(controls.map(control => control.injector.get(AioTooltipDirective).appTooltip())).toEqual(['New chat', 'New session']);
    const keybindings = TestBed.inject(KeybindingService);
    keybindings.customizeBinding('new-instance', { key: 'n', modifiers: ['alt'] }); fixture.detectChanges();
    const element = controls[1].nativeElement as HTMLElement;
    expect(element.getAttribute('aria-keyshortcuts')).toBe('Alt+N');
    const matches = element.matches.bind(element);
    vi.spyOn(element, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    element.dispatchEvent(new FocusEvent('focus')); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('New session');
    expect(document.querySelector('[role="tooltip"] kbd')?.textContent).toBe('Alt+N');
  });
});
