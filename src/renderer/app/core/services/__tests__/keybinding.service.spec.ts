import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEYBINDING_ELIGIBILITY_STATE } from '../../../../../shared/types/keybinding.types';
import { ActionDispatchService } from '../action-dispatch.service';
import { KeybindingService } from '../keybinding.service';

describe('KeybindingService input-context gate', () => {
  const dispatch = {
    getState: vi.fn(() => ({
      ...DEFAULT_KEYBINDING_ELIGIBILITY_STATE,
      instanceSelected: true,
      multipleInstances: true,
    })),
    dispatch: vi.fn(async () => true),
  };
  let service: KeybindingService;
  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    dispatch.dispatch.mockClear();
    TestBed.configureTestingModule({
      providers: [
        KeybindingService,
        { provide: ActionDispatchService, useValue: dispatch },
      ],
    });
    service = TestBed.inject(KeybindingService);
    service.setContext('input');
    textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
  });

  afterEach(() => {
    textarea.remove();
    TestBed.resetTestingModule();
  });

  it('does not steal plain digits from textarea input', () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: '1',
      bubbles: true,
      cancelable: true,
    }));

    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches numeric visible-instance shortcuts with the platform command modifier', () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: '1',
      bubbles: true,
      cancelable: true,
      ctrlKey: !service.isMac,
      metaKey: service.isMac,
    }));

    expect(dispatch.dispatch).toHaveBeenCalledWith('select-visible-instance-1');
  });
});
