import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { PlanQueueStartFormComponent, type PlanQueueParentSessionOption, type PlanQueueStartRequest } from './plan-queue-start-form.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-start-form.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-start-form.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-start-form.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-start-form.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const sessions: PlanQueueParentSessionOption[] = [
  { id: 'inst-1', label: 'Session A (claude)', workingDirectory: '/repo-a' },
  { id: 'inst-2', label: 'Session B (codex)', workingDirectory: '/repo-b' },
];

describe('PlanQueueStartFormComponent', () => {
  let fixture: ComponentFixture<PlanQueueStartFormComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PlanQueueStartFormComponent] }).compileComponents();
    fixture = TestBed.createComponent(PlanQueueStartFormComponent);
    fixture.componentRef.setInput('parentSessions', sessions);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  function select(): HTMLSelectElement {
    return fixture.nativeElement.querySelector('select') as HTMLSelectElement;
  }

  function submitButton(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement;
  }

  it('lists every parent session with its working directory', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Session A (claude)');
    expect(text).toContain('/repo-a');
    expect(text).toContain('Session B (codex)');
  });

  it('disables Start run until a parent session is chosen', () => {
    expect(submitButton().disabled).toBe(true);
  });

  it('enables Start run once a parent session is chosen', async () => {
    select().value = 'inst-1';
    select().dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(submitButton().disabled).toBe(false);
  });

  it('emits the start request with the chosen parent workspace and default kind plans', async () => {
    const emitted: PlanQueueStartRequest[] = [];
    fixture.componentInstance.start.subscribe((r) => emitted.push(r));

    select().value = 'inst-1';
    select().dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();
    submitButton().click();

    expect(emitted).toEqual([{ parentInstanceId: 'inst-1', kind: 'plans', workspaceCwd: '/repo-a' }]);
  });

  it('emits the chosen kind and an optional glob', async () => {
    const emitted: PlanQueueStartRequest[] = [];
    fixture.componentInstance.start.subscribe((r) => emitted.push(r));

    select().value = 'inst-2';
    select().dispatchEvent(new Event('change'));

    const livetestsRadio = Array.from(
      fixture.nativeElement.querySelectorAll('input[type="radio"]'),
    ).find((el) => (el as HTMLInputElement).value === 'livetests') as HTMLInputElement;
    livetestsRadio.dispatchEvent(new Event('change'));

    const globInput = fixture.nativeElement.querySelector('input[type="text"]') as HTMLInputElement;
    globInput.value = 'docs/plans/**/*_plan.md';
    globInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    submitButton().click();

    expect(emitted).toEqual([
      { parentInstanceId: 'inst-2', kind: 'livetests', workspaceCwd: '/repo-b', glob: 'docs/plans/**/*_plan.md' },
    ]);
  });

  it('does not emit when submitted with no parent session chosen', () => {
    const emitted: PlanQueueStartRequest[] = [];
    fixture.componentInstance.start.subscribe((r) => emitted.push(r));

    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit'));

    expect(emitted).toHaveLength(0);
  });
});
