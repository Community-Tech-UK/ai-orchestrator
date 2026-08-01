import {
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AutomationExecutionProfileSelectorComponent } from './automation-execution-profile-selector.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const templateSource = readFileSync(resolve(specDirectory, './automation-execution-profile-selector.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './automation-execution-profile-selector.component.css'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('automation-execution-profile-selector.component.html')) return Promise.resolve(templateSource);
  if (url.endsWith('automation-execution-profile-selector.component.css')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.css') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('AutomationExecutionProfileSelectorComponent', () => {
  let fixture: ComponentFixture<AutomationExecutionProfileSelectorComponent>;

  async function create(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [AutomationExecutionProfileSelectorComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(AutomationExecutionProfileSelectorComponent);
  }

  it('renders both radio options with the standard one checked by default', async () => {
    await create();
    fixture.componentRef.setInput('value', 'standard');
    fixture.detectChanges();

    const radios = Array.from(fixture.nativeElement.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
  });

  it('emits valueChange when the Contained option is picked', async () => {
    await create();
    fixture.componentRef.setInput('value', 'standard');
    fixture.detectChanges();

    let emitted: unknown;
    fixture.componentInstance.valueChange.subscribe((v: unknown) => {
      emitted = v;
    });
    const radios = Array.from(fixture.nativeElement.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    radios[1].dispatchEvent(new Event('change'));
    expect(emitted).toBe('contained');
  });

  it('shows no mismatch warning when contained resolves to codex', async () => {
    await create();
    fixture.componentRef.setInput('value', 'contained');
    fixture.componentRef.setInput('resolvedProvider', 'codex');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.profile-warning')).toBeNull();
  });

  it('shows an inline mismatch warning when contained resolves to a non-codex provider', async () => {
    await create();
    fixture.componentRef.setInput('value', 'contained');
    fixture.componentRef.setInput('resolvedProvider', 'claude');
    fixture.detectChanges();

    const warning = fixture.nativeElement.querySelector('.profile-warning') as HTMLElement | null;
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toMatch(/codex/i);
  });

  it('shows no mismatch warning while standard is selected regardless of provider', async () => {
    await create();
    fixture.componentRef.setInput('value', 'standard');
    fixture.componentRef.setInput('resolvedProvider', 'claude');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.profile-warning')).toBeNull();
  });
});
