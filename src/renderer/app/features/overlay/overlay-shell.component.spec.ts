import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OverlayShellComponent } from './overlay-shell.component';
import type { OverlayController, OverlayItem } from './overlay.types';

function makeController(): OverlayController {
  const query = signal('');
  const groups = signal([{
    id: 'main',
    label: 'Main',
    items: [
      { id: 'one', label: 'One', value: 'one' },
    ] satisfies OverlayItem[],
  }]);

  return {
    title: 'Command palette',
    placeholder: 'Search',
    emptyLabel: 'Empty',
    query,
    groups,
    setQuery: query.set,
    run: () => true,
  };
}

describe('OverlayShellComponent focus trap', () => {
  let fixture: ComponentFixture<OverlayShellComponent> | null;
  let opener: HTMLButtonElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OverlayShellComponent],
    }).compileComponents();

    opener = document.createElement('button');
    opener.textContent = 'Open palette';
    document.body.append(opener);
    opener.focus();
    fixture = null;
  });

  afterEach(() => {
    fixture?.destroy();
    opener.remove();
  });

  it('restores focus to the opener when the overlay is destroyed', async () => {
    fixture = TestBed.createComponent(OverlayShellComponent);
    (fixture.componentInstance as unknown as { controller: () => OverlayController }).controller = () => makeController();
    opener.focus();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const input = fixture.nativeElement.querySelector('.overlay-input') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    input!.focus();
    expect(document.activeElement).toBe(input);

    fixture.destroy();

    expect(document.activeElement).toBe(opener);
  });
});
