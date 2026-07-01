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
});
