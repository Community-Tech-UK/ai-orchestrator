import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileAttachment } from '../../../../../shared/types/instance.types';
import { InstanceIpcService } from '../../services/ipc/instance-ipc.service';
import { SettingsStore } from '../settings.store';
import type { QueuedMessage } from './instance.types';
import { InstanceStateService } from './instance-state.service';
import { QueuePersistenceService } from './queue-persistence.service';

interface InitialPromptPayload {
  instanceId: string;
  message: string;
  attachments?: FileAttachment[];
  seededAlready: true;
}

describe('QueuePersistenceService', () => {
  let initialPromptHandler: ((payload: InitialPromptPayload) => void) | undefined;
  let queueSignal: ReturnType<typeof signal<Map<string, QueuedMessage[]>>>;
  let settingsValues: Record<string, boolean>;

  beforeEach(() => {
    initialPromptHandler = undefined;
    queueSignal = signal(new Map<string, QueuedMessage[]>());
    settingsValues = {
      pauseFeatureEnabled: true,
      persistSessionContent: false,
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        QueuePersistenceService,
        {
          provide: InstanceStateService,
          useValue: {
            messageQueue: queueSignal,
          },
        },
        {
          provide: InstanceIpcService,
          useValue: {
            onInstanceQueueInitialPrompt: vi.fn((handler: (payload: InitialPromptPayload) => void) => {
              initialPromptHandler = handler;
              return vi.fn();
            }),
            instanceQueueLoadAll: vi.fn(),
            instanceQueueSave: vi.fn(),
          },
        },
        {
          provide: SettingsStore,
          useValue: {
            isInitialized: vi.fn(() => true),
            get: vi.fn((key: string) => settingsValues[key] ?? false),
          },
        },
      ],
    });
  });

  it('subscribes to initial prompt broadcasts when session persistence is disabled', () => {
    const service = TestBed.inject(QueuePersistenceService);

    service.subscribeToInitialPrompts();
    initialPromptHandler?.({
      instanceId: 'inst-1',
      message: 'Seeded prompt',
      seededAlready: true,
    });

    expect(queueSignal().get('inst-1')).toEqual([
      {
        message: 'Seeded prompt',
        files: undefined,
        seededAlready: true,
        hadAttachmentsDropped: false,
      },
    ]);
  });

  it('does not subscribe to initial prompt broadcasts when the pause feature is disabled', () => {
    settingsValues.pauseFeatureEnabled = false;
    const service = TestBed.inject(QueuePersistenceService);

    service.subscribeToInitialPrompts();

    expect(initialPromptHandler).toBeUndefined();
  });
});
