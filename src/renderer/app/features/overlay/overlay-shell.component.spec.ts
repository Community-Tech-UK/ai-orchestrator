import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OverlayShellComponent } from './overlay-shell.component';
import type { OverlayController, OverlayGroup, OverlayItem } from './overlay.types';
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

@Component({
  selector: 'app-overlay-footer-host',
  standalone: true,
  imports: [OverlayShellComponent],
  template: `
    <ng-template #footer let-item>
      @if (item.id === 'manual') {
        <button type="button" class="footer-action" (click)="footerClicks += 1">
          Run manual action
        </button>
      }
    </ng-template>

    <app-overlay-shell
      [controller]="controller"
      [itemFooter]="footer"
      (selected)="selectedIds.push($event.id)"
    />
  `,
})
class OverlayFooterHostComponent {
  readonly query = signal('');
  readonly groups = signal<OverlayGroup[]>([{
    id: 'main',
    label: 'Main',
    items: [
      { id: 'manual', label: 'Manual row', activationMode: 'manual', value: 'manual' },
      { id: 'ordinary', label: 'Ordinary row', value: 'ordinary' },
    ],
  }]);
  readonly selectedIds: string[] = [];
  footerClicks = 0;

  readonly controller: OverlayController = {
    title: 'Command palette',
    placeholder: 'Search',
    emptyLabel: 'Empty',
    query: this.query.asReadonly(),
    groups: this.groups.asReadonly(),
    setQuery: (query) => this.query.set(query),
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

  it('renders manual footer-action rows as non-activating groups while ordinary rows remain button-like', async () => {
    const hostFixture = TestBed.createComponent(OverlayFooterHostComponent);
    hostFixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    hostFixture.detectChanges();

    const rows = Array.from(
      hostFixture.nativeElement.querySelectorAll('.overlay-row') as NodeListOf<HTMLElement>,
    );
    const manual = rows[0];
    const ordinary = rows[1];
    const action = manual.querySelector('.footer-action') as HTMLButtonElement | null;

    expect(manual.getAttribute('role')).toBe('group');
    expect(manual.getAttribute('tabindex')).toBeNull();
    expect(action?.parentElement?.closest('[role="button"][tabindex="0"]')).toBeNull();
    expect(ordinary.getAttribute('role')).toBe('button');
    expect(ordinary.getAttribute('tabindex')).toBe('0');

    manual.click();
    manual.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    manual.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    action?.click();
    ordinary.click();

    expect(hostFixture.componentInstance.footerClicks).toBe(1);
    expect(hostFixture.componentInstance.selectedIds).toEqual(['ordinary']);
    hostFixture.destroy();
  });
});
