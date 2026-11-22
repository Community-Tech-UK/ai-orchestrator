import { Component, input, output } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { OverlayShellComponent } from '../overlay/overlay-shell.component';
import { CommandPaletteComponent } from './command-palette.component';
import { CommandPaletteController } from './command-palette.controller';

@Component({ selector: 'app-overlay-shell', template: '' })
class ShellStub {
  controller = input<unknown>();
  closeRequested = output<void>();
  selected = output<unknown>();
}

describe('CommandPaletteComponent', () => {
  it('clears the last search text each time the palette opens', () => {
    const setQuery = vi.fn();
    TestBed.overrideComponent(CommandPaletteComponent, {
      remove: { imports: [OverlayShellComponent] },
      add: { imports: [ShellStub] },
    });
    TestBed.configureTestingModule({ providers: [{ provide: CommandPaletteController, useValue: { setQuery } }] });

    TestBed.createComponent(CommandPaletteComponent).detectChanges();
    TestBed.createComponent(CommandPaletteComponent).detectChanges();

    expect(setQuery).toHaveBeenCalledTimes(2);
    expect(setQuery).toHaveBeenCalledWith('');
  });
});
