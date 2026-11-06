import { TestBed } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { SessionArtifactsStripComponent } from './session-artifacts-strip.component';

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
