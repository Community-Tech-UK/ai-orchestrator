import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../../core/state/settings.store';
import { PaletteOverlaysService } from './palette-overlays.service';
import { CommandPaletteComponent } from './command-palette.component';
import { CommandHelpHostComponent } from './command-help-host.component';
import { CommandPaletteHostComponent } from './command-palette-host.component';

@Component({ selector: 'app-command-palette', template: '' }) class PaletteStub {}
@Component({ selector: 'app-command-help-host', template: '' }) class HelpStub {}
describe('CommandPaletteHostComponent', () => {
  const role = signal('coordinator');
  const overlays = { commandPaletteOpen: signal(true), commandHelpOpen: signal(false) };
  beforeEach(() => {
    role.set('coordinator'); overlays.commandPaletteOpen.set(true); overlays.commandHelpOpen.set(false);
    TestBed.overrideComponent(CommandPaletteHostComponent, {
      remove: { imports: [CommandPaletteComponent, CommandHelpHostComponent] },
      add: { imports: [PaletteStub, HelpStub] },
    });
    TestBed.configureTestingModule({ providers: [
      { provide: SettingsStore, useValue: { harnessRole: role } },
      { provide: PaletteOverlaysService, useValue: overlays },
    ] });
  });
  it('renders the shared palette and help according to the root service', () => {
    const fixture = TestBed.createComponent(CommandPaletteHostComponent); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-command-palette')).toBeTruthy();
    overlays.commandPaletteOpen.set(false); overlays.commandHelpOpen.set(true); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-command-palette')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-command-help-host')).toBeTruthy();
  });
  it.each(['worker', 'unset'])('renders no overlay for %s', value => {
    role.set(value);
    const fixture = TestBed.createComponent(CommandPaletteHostComponent); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-command-palette')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-command-help-host')).toBeNull();
  });
});
