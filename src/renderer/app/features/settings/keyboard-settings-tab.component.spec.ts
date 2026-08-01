/**
 * Unit tests for KeyboardSettingsTabComponent (Task 13): the tab renders the
 * conflict banner + import/export controls and drives the KeybindingService.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyboardSettingsTabComponent } from './keyboard-settings-tab.component';
import { KeybindingService } from '../../core/services/keybinding.service';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(specDirectory, './keyboard-settings-tab.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('keyboard-settings-tab.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('KeyboardSettingsTabComponent', () => {
  let fixture: ComponentFixture<KeyboardSettingsTabComponent>;
  let service: KeybindingService;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [KeyboardSettingsTabComponent] });
    service = TestBed.inject(KeybindingService);
    service.resetAllBindings();
    fixture = TestBed.createComponent(KeyboardSettingsTabComponent);
    fixture.detectChanges();
  });

  it('renders the shortcut list without a conflict banner by default', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain('keybinding conflict');
  });

  it('shows the conflict banner when a customization introduces a conflict', () => {
    service.customizeBinding('focus-input', { key: 'o', modifiers: [] });
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('.keybinding-conflicts');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('conflict');
  });

  it('surfaces blocked import conflict details without applying the import', () => {
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = JSON.stringify([{ id: 'focus-input', keys: { key: 'o', modifiers: [] } }]);
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const before = service.getCustomizations();
    const importButton = [...fixture.nativeElement.querySelectorAll('button')]
      .find((button: HTMLButtonElement) => button.textContent?.includes('Import shortcuts')) as HTMLButtonElement;
    importButton.click();
    fixture.detectChanges();

    const pending = fixture.nativeElement.querySelector('.keybinding-import-conflicts');
    expect(pending).toBeTruthy();
    expect(pending.textContent).toContain('focus-input');
    expect(pending.textContent).toContain('focus-output');
    expect(service.getCustomizations()).toEqual(before);
  });

  it('rejects (does not apply) an import that claims a reserved platform combo (WS-C9)', () => {
    // jsdom reports an empty navigator.platform, so KeybindingService resolves
    // to the 'other' reserved-key list here — use one of those combos.
    expect(service.isMac).toBe(false);
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = JSON.stringify([{ id: 'focus-input', keys: { key: 'F4', modifiers: ['alt'] } }]);
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const before = service.getCustomizations();
    const importButton = [...fixture.nativeElement.querySelectorAll('button')]
      .find((button: HTMLButtonElement) => button.textContent?.includes('Import shortcuts')) as HTMLButtonElement;
    importButton.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('reserved shortcut');
    expect(service.getCustomizations()).toEqual(before);
  });

  it('groups shortcuts by context and searches by name/description/context (WS-C9)', () => {
    const groupHeadings = [...fixture.nativeElement.querySelectorAll('.category-title')].map(
      (el: HTMLElement) => el.textContent,
    );
    expect(groupHeadings).toContain('Composer / input');
    expect(groupHeadings).toContain('Global');

    const search = fixture.nativeElement.querySelector('.keybinding-search') as HTMLInputElement;
    search.value = 'focus the message input';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const rows = [...fixture.nativeElement.querySelectorAll('.shortcut-name')].map(
      (el: HTMLElement) => el.textContent,
    );
    expect(rows).toEqual(['Focus Input']);
  });

  it('renders every hint through ShortcutHintPipe (live resolver), matching KeybindingService.formatBinding', () => {
    const search = fixture.nativeElement.querySelector('.keybinding-search') as HTMLInputElement;
    search.value = 'Focus Input';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const kbd = fixture.nativeElement.querySelector('.shortcut-keys kbd') as HTMLElement;
    expect(kbd.textContent).toBe(service.formatBindingByAction('focus-input'));
  });
});
