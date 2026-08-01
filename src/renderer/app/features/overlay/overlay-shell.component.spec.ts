import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OverlayShellComponent } from './overlay-shell.component';
import type { OverlayController, OverlayItem } from './overlay.types';
import { KeybindingService } from '../../core/services/keybinding.service';

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

  it(
    'stops Escape from bubbling to document (WS-C9: prevents the global cancel-operation ' +
      "binding from re-firing behind the overlay's own close)",
    async () => {
      fixture = TestBed.createComponent(OverlayShellComponent);
      (fixture.componentInstance as unknown as { controller: () => OverlayController }).controller = () =>
        makeController();
      fixture.detectChanges();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const input = fixture.nativeElement.querySelector('.overlay-input') as HTMLInputElement;
      let sawEscapeAtDocument = false;
      const documentListener = (event: KeyboardEvent) => {
        if (event.key === 'Escape') sawEscapeAtDocument = true;
      };
      document.addEventListener('keydown', documentListener);

      let closed = false;
      fixture.componentInstance.closeRequested.subscribe(() => {
        closed = true;
      });

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

      document.removeEventListener('keydown', documentListener);
      expect(closed).toBe(true);
      expect(sawEscapeAtDocument).toBe(false);
    },
  );

  it("sets the 'overlay' keybinding context while mounted and restores the prior context on destroy", async () => {
    const keybindingService = TestBed.inject(KeybindingService);
    keybindingService.setContext('input');

    fixture = TestBed.createComponent(OverlayShellComponent);
    (fixture.componentInstance as unknown as { controller: () => OverlayController }).controller = () =>
      makeController();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(keybindingService.getContext()).toBe('overlay');

    fixture.destroy();
    fixture = null;

    expect(keybindingService.getContext()).toBe('input');
  });
});
