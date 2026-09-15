import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ModelSheetComponent } from './model-sheet.component';

function button(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

async function setup() {
  TestBed.overrideComponent(ModelSheetComponent, { set: { imports: [], schemas: [NO_ERRORS_SCHEMA] } });
  await TestBed.configureTestingModule({ imports: [ModelSheetComponent] }).compileComponents();
  const fixture = TestBed.createComponent(ModelSheetComponent);
  const selected = signal<string | undefined>('example-older');
  const effort = signal<string | undefined>('high');
  const saving = signal(false);
  // Vitest uses JIT without Angular's signal-input metadata transform.
  Object.defineProperties(fixture.componentInstance, {
    saving: { value: saving }, selected: { value: selected }, selectedReasoning: { value: effort },
    models: { value: signal([
      { id: 'example-latest', name: 'Latest Example', tier: 'balanced', pinned: true },
      { id: 'example-older', name: 'Older Example', tier: 'balanced', family: 'Example' },
    ]) },
    reasoningOptions: { value: signal([
      { id: 'high', label: 'High', description: 'More thinking' },
      { id: 'low', label: 'Low', description: 'Less thinking' },
    ]) },
  });
  fixture.componentInstance.choose.subscribe((value) => selected.set(value));
  fixture.componentInstance.chooseReasoning.subscribe((value) => effort.set(value));
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, selected, effort, saving };
}

describe('ModelSheetComponent', () => {
  it('exposes a selected older model when opened, including its row', async () => {
    const { root } = await setup();
    expect(root.querySelector('.model-current')?.textContent).toContain('Older Example');
    expect(button(root, 'Other versions').getAttribute('aria-expanded')).toBe('true');
    expect(button(root, 'Older Example').classList.contains('model-row--selected')).toBe(true);
    expect(button(root, 'Older Example').getAttribute('aria-pressed')).toBe('true');
  });

  it('allows model and reasoning selection before one explicit Done dismissal', async () => {
    const { root, fixture, selected, effort } = await setup();
    const dismissed = vi.fn(); fixture.componentInstance.dismiss.subscribe(dismissed);
    button(root, 'Latest Example').click(); fixture.detectChanges();
    button(root, 'Low').click(); fixture.detectChanges();
    expect(selected()).toBe('example-latest'); expect(effort()).toBe('low');
    expect(dismissed).not.toHaveBeenCalled();
    const sheet = root.querySelector('app-mobile-sheet')!;
    expect(sheet.getAttribute('closeLabel')).toBe('Done');
    sheet.dispatchEvent(new Event('dismiss'));
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  it('shows model saving and prevents competing selection or dismissal', async () => {
    const { root, fixture, saving } = await setup();
    saving.set(true); fixture.detectChanges();
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Changing model');
    expect(button(root, 'Latest Example').disabled).toBe(true);
    expect(button(root, 'Low').disabled).toBe(true);
    expect((root.querySelector('app-mobile-sheet') as unknown as { dismissible: boolean }).dismissible).toBe(false);
  });

  it('forwards the stable opener when the model-launching settings row is removed', async () => {
    const { fixture, root } = await setup();
    const opener = document.createElement('button');
    const target = signal<HTMLElement | null>(opener);
    Object.defineProperty(fixture.componentInstance, 'returnFocusTo', { value: target });
    // A tracked input schedules the same template that receives the explicit opener.
    (fixture.componentInstance.saving as unknown as { set(value: boolean): void }).set(true);
    fixture.detectChanges();
    expect((root.querySelector('app-mobile-sheet') as unknown as { returnFocusTo: HTMLElement }).returnFocusTo).toBe(opener);
  });

  it('keeps the current model visible when Other versions is collapsed', async () => {
    const { root, fixture } = await setup();
    button(root, 'Other versions').click(); fixture.detectChanges();
    expect(button(root, 'Other versions').getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.model-current')?.textContent).toContain('Older Example');
  });
});
