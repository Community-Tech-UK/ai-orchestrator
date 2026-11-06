import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { RemoteBrowseModalComponent } from './remote-browse-modal.component';
import { RemoteFsIpcService } from '../../../core/services/ipc/remote-fs-ipc.service';
import { RemoteNodeStore } from '../../../core/state/remote-node.store';

describe('RemoteBrowseModalComponent folder selection', () => {
  it('explains missing selection on keyboard focus, blocks confirmation and recovers', () => {
    TestBed.configureTestingModule({
      imports: [RemoteBrowseModalComponent],
      providers: [
        { provide: RemoteFsIpcService, useValue: { readDirectory: vi.fn(async () => ({ entries: [], truncated: false })) } },
        { provide: RemoteNodeStore, useValue: { nodeById: () => null } },
      ],
    });
    const fixture = TestBed.createComponent(RemoteBrowseModalComponent);
    fixture.componentRef.setInput('nodeId', 'test-node');
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.btn-primary') as HTMLButtonElement;
    const selected = vi.fn();
    fixture.componentInstance.folderSelected.subscribe(selected);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // jsdom needs the keyboard-focus selector supplied explicitly.
    vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible');
    button.focus();
    fixture.detectChanges();
    expect(document.activeElement).toBe(button);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Select a folder first.');
    button.click();
    expect(selected).not.toHaveBeenCalled();
    fixture.componentInstance.selectedPath.set('/project');
    fixture.detectChanges();
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    button.click();
    expect(selected).toHaveBeenCalledExactlyOnceWith('/project');
    fixture.destroy();
  });
});
