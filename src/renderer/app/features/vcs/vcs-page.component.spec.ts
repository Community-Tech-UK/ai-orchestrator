import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { VcsPageComponent } from './vcs-page.component';
import { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';

const specDirectory = dirname(fileURLToPath(import.meta.url));

await resolveComponentResources(url => Promise.resolve(
  url.endsWith('vcs-page.component.html')
    ? readFileSync(resolve(specDirectory, './vcs-page.component.html'), 'utf8') : '',
));

describe('VcsPageComponent required paths', () => {
  it('explains empty directory and file paths, blocks requests, and accepts corrected values', async () => {
    const vcs = {
      vcsIsRepo: vi.fn(async () => ({ success: true, data: true })),
      vcsGetStatus: vi.fn(async () => ({ success: true, data: { branch: 'main' } })),
      vcsGetBranches: vi.fn(async () => ({ success: true, data: [] })),
      vcsGetCommits: vi.fn(async () => ({ success: true, data: [] })),
      vcsGetFileHistory: vi.fn(async () => ({ success: true, data: [] })),
    };
    TestBed.configureTestingModule({ imports: [VcsPageComponent], providers: [
      { provide: Router, useValue: {} }, { provide: VcsIpcService, useValue: vcs },
    ] });
    const fixture = TestBed.createComponent(VcsPageComponent);
    fixture.detectChanges();
    const load = fixture.nativeElement.querySelector('.dir-bar button') as HTMLButtonElement;
    expect(load.disabled).toBe(false);
    expect(load.getAttribute('aria-disabled')).toBe('true');
    vi.spyOn(load, 'matches').mockImplementation(selector => selector === ':focus-visible');
    load.focus();
    fixture.detectChanges();
    expect(document.activeElement).toBe(load);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Enter a working directory first.');
    load.click();
    expect(vcs.vcsIsRepo).not.toHaveBeenCalled();
    fixture.componentInstance.workingDir.set('/project');
    fixture.detectChanges();
    expect(load.hasAttribute('aria-disabled')).toBe(false);
    load.click();
    await fixture.whenStable();
    fixture.componentInstance.historyDrawerOpen.set(true);
    fixture.detectChanges();
    expect(vcs.vcsIsRepo).toHaveBeenCalledWith('/project');
    const history = fixture.nativeElement.querySelector('.history-input-row button') as HTMLButtonElement;
    expect(history.disabled).toBe(false);
    expect(history.getAttribute('aria-disabled')).toBe('true');
    vi.spyOn(history, 'matches').mockImplementation(selector => selector === ':focus-visible');
    history.focus();
    fixture.detectChanges();
    expect(document.activeElement).toBe(history);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Enter a file path first.');
    history.click();
    expect(vcs.vcsGetFileHistory).not.toHaveBeenCalled();
    fixture.componentInstance.historyFilePath.set('src/main.ts');
    fixture.detectChanges();
    expect(history.hasAttribute('aria-disabled')).toBe(false);
    history.click();
    await fixture.whenStable();
    expect(vcs.vcsGetFileHistory).toHaveBeenCalledWith('/project', 'src/main.ts', 20);
    fixture.destroy();
  });
});
