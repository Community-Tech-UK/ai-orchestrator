import { Component, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpDrawerComponent } from './help-drawer.component';
import { HelpDrawerService } from './help-drawer.service';
import { createFocusTrap, type FocusTrapHandle } from '../utils/focus-trap';

const directory = dirname(fileURLToPath(import.meta.url));
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
await resolveComponentResources(url => Promise.resolve(readFileSync(resolve(directory, url), 'utf8')));

@Component({ standalone: true, imports: [HelpDrawerComponent], template: `
  <div class="settings-page" tabindex="0" (keydown.escape)="settingsClosed = true"><aside id="settings"><button id="opener">Open Words</button></aside></div>
  <app-help-drawer />` })
class Host { settingsClosed = false; }

describe('HelpDrawerComponent', () => {
  let fixture: ComponentFixture<Host>;
  let drawer: HelpDrawerService;
  let settingsTrap: FocusTrapHandle;
  const scrollIntoView = vi.fn();
  beforeEach(async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() { /* jsdom has no layout observer. */ }
      disconnect() { /* Nothing is observed. */ }
      unobserve() { /* Nothing is observed. */ }
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    drawer = TestBed.inject(HelpDrawerService);
    settingsTrap = createFocusTrap(fixture.nativeElement.querySelector('#settings'));
    settingsTrap.activate();
  });
  afterEach(() => {
    fixture?.destroy();
    settingsTrap?.restore();
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function render(): Promise<void> {
    fixture.detectChanges();
    TestBed.tick();
    await fixture.whenStable();
  }
  it('opens a modal, traps Tab and restores focus after Escape', async () => {
    const opener = fixture.nativeElement.querySelector('#opener');
    expect(document.activeElement).toBe(opener);
    drawer.open({ topic: 'loop' });
    await render();
    const dialog: HTMLElement = fixture.nativeElement.querySelector('app-help-drawer [role="dialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(dialog.contains(document.activeElement)).toBe(true);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await render();
    expect(drawer.target()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(fixture.componentInstance.settingsClosed).toBe(false);
    opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(fixture.componentInstance.settingsClosed).toBe(true);
  });
  it('scrolls and focuses the requested definition and closes from its scrim', async () => {
    drawer.open({ topic: 'glossary', anchor: 'worktree' });
    await render();
    const anchor = fixture.nativeElement.querySelector('#term-worktree');
    expect(anchor).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(document.activeElement).toBe(anchor);
    fixture.nativeElement.querySelector('.help-scrim').click();
    await render();
    expect(drawer.target()).toBeNull();
    expect(document.activeElement?.id).toBe('opener');
  });
  it('keeps focus inside when switching from an anchored word to another topic', async () => {
    drawer.open({ topic: 'glossary', anchor: 'worktree' });
    await render();
    drawer.open({ topic: 'session' });
    await render();
    const dialog: HTMLElement = fixture.nativeElement.querySelector('app-help-drawer [role="dialog"]');
    expect(dialog.contains(document.activeElement)).toBe(true);
    drawer.close();
    await render();
    expect(document.activeElement?.id).toBe('opener');
  });
});
