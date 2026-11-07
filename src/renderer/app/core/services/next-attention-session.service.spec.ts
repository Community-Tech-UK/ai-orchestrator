import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { Router } from '@angular/router';
import { InstanceStore } from '../state/instance.store';
import { DEFAULT_KEYBINDINGS } from '../../../../shared/types/keybinding.types';
import { ActionDispatchService } from './action-dispatch.service';
import { NextAttentionSessionService } from './next-attention-session.service';
describe('next session needing you', () => {
  it('registers a live shortcut that cycles through actionable sessions and returns to the dashboard', async () => {
    const instances = signal([{ id: 'one', status: 'busy' }, { id: 'two', status: 'waiting_for_input' },
      { id: 'three', status: 'initializing', waitReason: { kind: 'auth-required' } }]);
    const selected = signal('one');
    let run!: () => Promise<void>;
    const store = { instances, selectedInstanceId: selected, setSelectedInstance: (id: string) => selected.set(id) };
    const router = { navigateByUrl: vi.fn(async () => true) };
    TestBed.configureTestingModule({ providers: [
      { provide: InstanceStore, useValue: store },
      { provide: Router, useValue: router },
      { provide: ActionDispatchService, useValue: { register: (action: { run: () => Promise<void> }) => { run = action.run; return () => undefined; } } },
    ] });
    TestBed.inject(NextAttentionSessionService);
    expect(DEFAULT_KEYBINDINGS).toContainEqual(expect.objectContaining({ id: 'next-attention-session', action: 'next-attention-session', context: 'global' }));
    await run(); expect(selected()).toBe('two');
    await run(); expect(selected()).toBe('three');
    await run(); expect(selected()).toBe('two');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/');
    TestBed.resetTestingModule();
  });
});
