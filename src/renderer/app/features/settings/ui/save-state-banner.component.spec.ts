import {
  ɵresolveComponentResources as resolveComponentResources,
  Component,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { SaveState, SaveStateBannerComponent } from './save-state-banner.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(specDirectory, './save-state-banner.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('save-state-banner.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

@Component({
  standalone: true,
  imports: [SaveStateBannerComponent],
  template: `<app-save-state-banner [state]="state" />`,
})
class SaveStateBannerHostComponent {
  state: SaveState = 'saved';
}

describe('SaveStateBannerComponent', () => {
  let fixture: ComponentFixture<SaveStateBannerHostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SaveStateBannerHostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SaveStateBannerHostComponent);
  });

  it('renders restart-required save state with apply and reset actions', () => {
    fixture.componentInstance.state = 'restart';
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Needs restart');
    expect(text).toContain('Reset');
    expect(text).toContain('Apply changes');
  });
});
