import { computed, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AskCouncilPageComponent } from './ask-council-page.component';
import { AskCouncilStore } from './ask-council.store';

await resolveComponentResources(url => Promise.resolve(url.endsWith('.html')
  ? readFileSync(join(__dirname, 'ask-council-page.component.html'), 'utf8') : ''));

describe('Council tooltip restrictions in the rendered page', () => {
  const running = signal(false);
  const starting = signal(false);
  const store = {
    availableProviders: signal(['claude']), loadingProviders: signal(false), starting,
    synthesizing: signal(false), errorMessage: signal(null), members: signal([]),
    isRunning: running, canSynthesize: signal(false), canCancel: computed(() => running()),
    synthesis: signal(null), succeededMembers: signal([]), failedMembers: signal([]), run: signal(null),
    initialize: vi.fn(async () => undefined), start: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    running.set(false); starting.set(false); vi.clearAllMocks();
    TestBed.configureTestingModule({ imports: [AskCouncilPageComponent], providers: [{ provide: AskCouncilStore, useValue: store }] });
  });

  it('explains missing input, blocks a click, and recovers without a native lasting disable', async () => {
    const fixture = TestBed.createComponent(AskCouncilPageComponent);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const ask = fixture.nativeElement.querySelector('.actions-row .btn-primary') as HTMLButtonElement;
    expect(ask.disabled).toBe(false);
    expect(ask.getAttribute('aria-disabled')).toBe('true');
    ask.click();
    expect(store.start).not.toHaveBeenCalled();
    fixture.componentInstance.prompt.set('Compare these approaches');
    fixture.detectChanges();
    expect(ask.getAttribute('aria-disabled')).toBeNull();
    ask.click(); await fixture.whenStable();
    expect(store.start).toHaveBeenCalledWith('Compare these approaches', ['claude']);
    starting.set(true); fixture.detectChanges();
    expect(ask.disabled).toBe(true);
    expect(ask.textContent).toContain('Starting');
  });

  it('protects the active prompt and providers while keeping their reason and Cancel reachable', async () => {
    running.set(true);
    const fixture = TestBed.createComponent(AskCouncilPageComponent);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const prompt = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    const reasonHost = prompt.parentElement!;
    expect(prompt.disabled).toBe(true);
    expect(reasonHost.tabIndex).toBe(0);
    const matches = reasonHost.matches.bind(reasonHost);
    vi.spyOn(reasonHost, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    reasonHost.focus(); fixture.detectChanges();
    expect(document.activeElement).toBe(reasonHost);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Wait for the current council to finish before editing its prompt');
    expect((fixture.nativeElement.querySelector('.provider-checkbox input') as HTMLInputElement).disabled).toBe(true);
    const all = fixture.nativeElement.querySelector('.btn-select-all') as HTMLButtonElement;
    expect(all.disabled).toBe(false);
    expect(all.getAttribute('aria-disabled')).toBe('true');
    fixture.componentInstance.selectedProviders.set([]);
    all.click();
    expect(fixture.componentInstance.selectedProviders()).toEqual([]);
    (fixture.nativeElement.querySelector('.btn-cancel') as HTMLButtonElement).click();
    expect(store.cancel).toHaveBeenCalledOnce();
    running.set(false); fixture.detectChanges();
    expect(prompt.disabled).toBe(false);
    expect(reasonHost.hasAttribute('tabindex')).toBe(false);
    expect(all.getAttribute('aria-disabled')).toBeNull();
    all.click();
    expect(fixture.componentInstance.selectedProviders()).toEqual(['claude']);
  });
});
