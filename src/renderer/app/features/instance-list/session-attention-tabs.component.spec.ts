import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../../core/state/instance.store';
import { NeedsYouStore } from '../workboard/needs-you.store';
import { SessionAttentionTabsComponent } from './session-attention-tabs.component';
import { loadStatusFilter, saveStatusFilter } from './instance-list-preferences';

describe('SessionAttentionTabsComponent', () => {
  afterEach(() => { TestBed.resetTestingModule(); localStorage.clear(); });
  it('counts sessions, keeps zero badges hidden and emits each persisted filter', () => {
    const instances = signal([{ id: 'a', status: 'waiting_for_input' }, { id: 'b', status: 'busy' }, { id: 'c', status: 'idle' }]);
    TestBed.configureTestingModule({ imports: [SessionAttentionTabsComponent], providers: [
      { provide: InstanceStore, useValue: { instances } },
      { provide: NeedsYouStore, useValue: { sessionIds: signal(new Set(['a', 'missing'])) } },
    ] });
    const fixture = TestBed.createComponent(SessionAttentionTabsComponent); fixture.detectChanges();
    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Needs you 1', 'Working 1', 'Idle 1', 'All 3']);
    const changed = vi.fn((value) => saveStatusFilter(value)); fixture.componentInstance.changed.subscribe(changed);
    buttons[0].click(); expect(loadStatusFilter()).toBe('attn:needs-you');
    buttons[1].click(); expect(loadStatusFilter()).toBe('attn:working');
    buttons[2].click(); expect(loadStatusFilter()).toBe('attn:idle');
    buttons[3].click(); expect(loadStatusFilter()).toBe('all');
    instances.set([]); fixture.detectChanges(); expect(buttons.some((b) => b.textContent?.includes('0'))).toBe(false);
  });
  it('migrates stored Active to All and preserves raw state filters', () => {
    saveStatusFilter('active'); expect(loadStatusFilter()).toBe('all');
    saveStatusFilter('waiting_for_permission'); expect(loadStatusFilter()).toBe('waiting_for_permission');
  });
});
