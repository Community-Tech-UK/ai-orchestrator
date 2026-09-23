import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { ViewLayoutService } from '../../core/services/view-layout.service';
import { HistorySidebarComponent } from './history-sidebar.component';

describe('HistorySidebarComponent', () => {
  it('keeps the sidebar open for clicks inside it and closes on the backdrop', async () => {
    await TestBed.configureTestingModule({
      imports: [HistorySidebarComponent],
      providers: [
        { provide: HistoryStore, useValue: {
          loadHistory: vi.fn(),
          searchQuery: signal(''),
          filteredEntries: signal([]),
          loading: signal(false),
          entryCount: signal(0),
          hasEntries: signal(false),
        } },
        { provide: InstanceStore, useValue: {} },
        { provide: FileIpcService, useValue: {} },
        { provide: ViewLayoutService, useValue: { historySidebarWidth: 360 } },
        { provide: Router, useValue: {} },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(HistorySidebarComponent);
    const close = vi.fn();
    fixture.componentInstance.closeHistory.subscribe(close);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    root.querySelector('h2')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(close).not.toHaveBeenCalled();

    root.querySelector('.history-backdrop')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(close).toHaveBeenCalledOnce();
  });
});
