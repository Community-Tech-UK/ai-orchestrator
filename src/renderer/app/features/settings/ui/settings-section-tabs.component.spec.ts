import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsSectionTabsComponent } from './settings-section-tabs.component';
import type { SettingsSectionTab } from '../settings-navigation';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(specDirectory, './settings-section-tabs.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('settings-section-tabs.component.scss')) {
    return Promise.resolve(styles);
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const TABS: SettingsSectionTab[] = [
  { id: 'overview', label: 'Overview', panelId: 'panel-overview' },
  { id: 'pairing', label: 'Pairing', panelId: 'panel-pairing', badge: '2' },
  { id: 'computers', label: 'Computers', panelId: 'panel-computers' },
];

describe('SettingsSectionTabsComponent', () => {
  let fixture: ComponentFixture<SettingsSectionTabsComponent>;
  let component: SettingsSectionTabsComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsSectionTabsComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SettingsSectionTabsComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('tabs', TABS);
    fixture.componentRef.setInput('activeId', 'overview');
    fixture.componentRef.setInput('ariaLabel', 'Remote Nodes sections');
    fixture.detectChanges();
  });

  it('renders a semantic tablist with selected state, aria-controls, and one tabindex="0"', () => {
    const tablist = fixture.nativeElement.querySelector('[role="tablist"]');
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');

    expect(tablist?.getAttribute('aria-label')).toBe('Remote Nodes sections');
    expect(tabs).toHaveLength(3);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('aria-controls')).toBe('panel-overview');
    expect(tabs[0].getAttribute('tabindex')).toBe('0');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    expect(tabs[1].getAttribute('tabindex')).toBe('-1');
    expect(tabs[2].getAttribute('tabindex')).toBe('-1');
    expect(tabs[1].textContent).toContain('2');

    const tabindexZeroCount = Array.from(tabs).filter(
      (tab) => (tab as HTMLElement).getAttribute('tabindex') === '0',
    ).length;
    expect(tabindexZeroCount).toBe(1);
  });

  it('activates a tab on click', () => {
    const emit = vi.spyOn(component.activeIdChange, 'emit');
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');

    tabs[1].click();

    expect(emit).toHaveBeenCalledWith('pairing');
  });

  it('does not re-emit when clicking the already-active tab', () => {
    const emit = vi.spyOn(component.activeIdChange, 'emit');
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');

    tabs[0].click();

    expect(emit).not.toHaveBeenCalled();
  });

  it('wraps ArrowRight/ArrowLeft and jumps with Home/End', () => {
    const emit = vi.spyOn(component.activeIdChange, 'emit');
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]') as NodeListOf<HTMLButtonElement>;

    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(emit).toHaveBeenLastCalledWith('pairing');

    fixture.componentRef.setInput('activeId', 'pairing');
    fixture.detectChanges();

    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(emit).toHaveBeenLastCalledWith('overview');

    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(emit).toHaveBeenLastCalledWith('computers');

    fixture.componentRef.setInput('activeId', 'computers');
    fixture.detectChanges();

    tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(emit).toHaveBeenLastCalledWith('overview');

    fixture.componentRef.setInput('activeId', 'overview');
    fixture.detectChanges();

    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(emit).toHaveBeenLastCalledWith('computers');
  });

  it('ignores unrelated keys', () => {
    const emit = vi.spyOn(component.activeIdChange, 'emit');
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]') as NodeListOf<HTMLButtonElement>;

    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps visible focus styling and a 40px minimum hit height for keyboard users', () => {
    expect(styles).toContain('.section-tab:focus-visible');
    expect(styles).toContain('min-height: 40px');
  });

  it('lets the strip itself scroll horizontally instead of the page', () => {
    expect(styles).toContain('overflow-x: auto');
  });
});
