import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { SessionArtifactsStripComponent } from './session-artifacts-strip.component';

describe('SessionArtifactsStripComponent context menu', () => {
  it('skips the backdrop and closes on Escape from a menu item without stopping the session', () => {
    TestBed.configureTestingModule({ providers: [{ provide: FileIpcService, useValue: {} }] });
    const fixture = TestBed.createComponent(SessionArtifactsStripComponent);
    const component = fixture.componentInstance;
    fixture.componentRef.setInput('workingDirectory', '/repo');
    fixture.componentRef.setInput('diffStats', { files: { 'report.md': { status: 'modified', added: 1, deleted: 0 } } });
    fixture.detectChanges();
    component.onContextMenu(new MouseEvent('contextmenu'), component.entries()[0]);
    fixture.detectChanges();
    const backdrop = fixture.nativeElement.querySelector('.ctx-menu-backdrop') as HTMLButtonElement;
    expect(backdrop.tabIndex).toBe(-1);
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');
    const cancelled = vi.fn();
    document.addEventListener('keydown', cancelled);
    try {
      fixture.nativeElement.querySelector('.ctx-menu button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(component.contextMenu()).toBeNull();
      expect(cancelled).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', cancelled);
      fixture.destroy();
    }
  });
});

it('keeps the outside-folder explanation on the focusable artifact without a nested title', () => {
  TestBed.configureTestingModule({ imports: [SessionArtifactsStripComponent], providers: [{ provide: FileIpcService, useValue: {} }] });
  const fixture = TestBed.createComponent(SessionArtifactsStripComponent);
  fixture.componentRef.setInput('workingDirectory', '/tmp/project');
  fixture.componentRef.setInput('diffStats', {
    totalAdded: 1, totalDeleted: 0,
    files: { '../notes.md': { path: '../notes.md', status: 'added', added: 1, deleted: 0 } },
  });
  fixture.detectChanges();
  const chip = fixture.nativeElement.querySelector('.chip') as HTMLButtonElement;
  expect(chip.textContent).toContain('notes.md');
  expect(chip.querySelector('[title]')).toBeNull();
  const matches = chip.matches.bind(chip);
  vi.spyOn(chip, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
  chip.focus(); fixture.detectChanges();
  expect(document.activeElement).toBe(chip);
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Outside working directory');
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('../notes.md');
});
