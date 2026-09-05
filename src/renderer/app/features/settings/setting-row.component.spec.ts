import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { SettingMetadata } from '../../../../shared/types/settings.types';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings-defaults';
import { SettingRowComponent } from './setting-row.component';

await resolveComponentResources((url) => {
  if (url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const autonomySetting: SettingMetadata = {
  key: 'computerUseAutonomyLevel',
  label: 'Computer Use autonomy level',
  description: 'How much of the desktop agents may drive.',
  type: 'select',
  category: 'advanced',
  options: [
    { value: 'guarded', label: 'Guarded' },
    { value: 'trusted', label: 'Trusted (default)' },
    { value: 'unrestricted', label: 'Unrestricted' },
  ],
};

describe('SettingRowComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('selects the persisted value after rendering its options', () => {
    const fixture = TestBed.createComponent(SettingRowComponent);
    fixture.componentRef.setInput('setting', autonomySetting);
    fixture.componentRef.setInput('value', 'unrestricted');
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('unrestricted');
  });
});

const jsonSetting: SettingMetadata = {
  key: 'computerUseAllowedAppsJson',
  label: 'Allowed apps',
  description: 'JSON list of apps agents may drive.',
  type: 'json',
  category: 'advanced',
};

const numberSetting: SettingMetadata = {
  key: 'sessionFailoverMaxSwitches',
  label: 'Max switches',
  description: 'How many times a session may move provider.',
  type: 'number',
  category: 'advanced',
  min: 1,
  max: 5,
};

function render(setting: SettingMetadata, value: unknown) {
  const fixture = TestBed.createComponent(SettingRowComponent);
  fixture.componentRef.setInput('setting', setting);
  fixture.componentRef.setInput('value', value);
  fixture.detectChanges();
  return fixture;
}

/**
 * S1.1: the four `type: 'json'` keys had no `@case`, so the row rendered a label
 * and an EMPTY control cell — the setting was unreachable from the UI entirely.
 */
describe('SettingRowComponent — json rows (S1.1)', () => {
  it('renders an editor instead of an empty cell', () => {
    const fixture = render(jsonSetting, '["Finder"]');
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe('["Finder"]');
  });

  it('pretty-prints a non-string value rather than showing [object Object]', () => {
    const fixture = render(jsonSetting, { apps: ['Finder'] });
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toContain('"apps"');
    expect(textarea.value).not.toContain('[object');
  });

  it('reports invalid JSON and does NOT emit, so a broken allow-list is never written', () => {
    const fixture = render(jsonSetting, '[]');
    const emitted: unknown[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));

    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '["unclosed"';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(fixture.nativeElement.querySelector('.json-error')).toBeTruthy();
  });

  it('emits once the text parses', () => {
    const fixture = render(jsonSetting, '[]');
    const emitted: { key: string; value: unknown }[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));

    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '["Finder"]';
    textarea.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(emitted).toEqual([{ key: 'computerUseAllowedAppsJson', value: '["Finder"]' }]);
  });

  it('treats empty text as valid rather than an error', () => {
    const fixture = render(jsonSetting, '[]');
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '   ';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.json-error')).toBeNull();
  });
});

/**
 * S1.7: `min`/`max` on a number input are advisory. Typing past them still fires
 * `change`, so the old handler emitted the out-of-range value and the write was
 * either persisted or rejected and silently reverted.
 */
describe('SettingRowComponent — number clamping (S1.7)', () => {
  function emitFor(typed: string) {
    const fixture = render(numberSetting, 2);
    const emitted: { key: string; value: unknown }[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));
    const input = fixture.nativeElement.querySelector('input[type="number"]') as HTMLInputElement;
    input.value = typed;
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    return { emitted, input };
  }

  it('clamps above the maximum', () => {
    const { emitted, input } = emitFor('999');
    expect(emitted).toEqual([{ key: 'sessionFailoverMaxSwitches', value: 5 }]);
    // The field must agree with what was emitted.
    expect(input.value).toBe('5');
  });

  it('clamps below the minimum', () => {
    expect(emitFor('-4').emitted).toEqual([{ key: 'sessionFailoverMaxSwitches', value: 1 }]);
  });

  it('passes an in-range value through untouched', () => {
    expect(emitFor('3').emitted).toEqual([{ key: 'sessionFailoverMaxSwitches', value: 3 }]);
  });

  it('restores the previous value and emits nothing for unparseable text', () => {
    const { emitted, input } = emitFor('abc');
    expect(emitted).toEqual([]);
    expect(input.value).toBe('2');
  });
});

/**
 * UX4.1 / S1.3 — a per-setting reset. Shown only when the value differs from the
 * shipped default, so an untouched row carries no extra control.
 */
describe('SettingRowComponent — reset to default (S1.3)', () => {
  const booleanSetting: SettingMetadata = {
    key: 'showThinking',
    label: 'Show thinking',
    description: 'Whether to show model reasoning.',
    type: 'boolean',
    category: 'general',
  };

  function resetButton(fixture: ReturnType<typeof render>): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('.setting-reset');
  }

  it('offers no reset when the value already equals the default', () => {
    const fixture = render(booleanSetting, DEFAULT_SETTINGS.showThinking);
    expect(resetButton(fixture)).toBeNull();
  });

  it('offers a reset once the value differs from the default', () => {
    const fixture = render(booleanSetting, !DEFAULT_SETTINGS.showThinking);
    expect(resetButton(fixture)).toBeTruthy();
  });

  it('emits the shipped default, not a hardcoded guess', () => {
    const fixture = render(booleanSetting, !DEFAULT_SETTINGS.showThinking);
    const emitted: { key: string; value: unknown }[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));

    resetButton(fixture)!.click();
    fixture.detectChanges();

    expect(emitted).toEqual([{ key: 'showThinking', value: DEFAULT_SETTINGS.showThinking }]);
  });

  it('names the default it will restore, rather than an unlabelled Reset', () => {
    const fixture = render(booleanSetting, !DEFAULT_SETTINGS.showThinking);
    expect(resetButton(fixture)!.getAttribute('aria-label')).toContain('default');
  });

  it('offers no reset for a key that has no shipped default', () => {
    // Cast: the point is a key with no shipped default, which by definition
    // is not in `keyof AppSettings`.
    const orphan = { ...booleanSetting, key: 'notARealSettingKey' } as unknown as SettingMetadata;
    expect(resetButton(render(orphan, true))).toBeNull();
  });
});
