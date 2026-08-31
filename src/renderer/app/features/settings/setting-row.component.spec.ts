import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { SettingMetadata } from '../../../../shared/types/settings.types';
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
