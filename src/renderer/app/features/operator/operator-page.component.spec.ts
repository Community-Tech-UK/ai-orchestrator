import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorThreadResult } from '../../../../shared/types/operator.types';
import { OperatorIpcService } from '../../core/services/ipc/operator-ipc.service';
import { OperatorPageComponent } from './operator-page.component';

describe('OperatorPageComponent', () => {
  let fixture: ComponentFixture<OperatorPageComponent>;
  let ipc: {
    getThread: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    listRuns: ReturnType<typeof vi.fn>;
    listProjects: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    const response: OperatorThreadResult = {
      conversation: {
        thread: {
          id: 'thread-operator',
          provider: 'orchestrator',
          nativeThreadId: 'orchestrator:global',
          nativeSessionId: null,
          nativeSourceKind: 'internal',
          sourceKind: 'orchestrator',
          sourcePath: null,
          workspacePath: null,
          title: 'Orchestrator',
          createdAt: 1,
          updatedAt: 2,
          lastSyncedAt: null,
          writable: true,
          nativeVisibilityMode: 'none',
          syncStatus: 'synced',
          conflictStatus: 'none',
          parentConversationId: null,
          metadata: {},
        },
        messages: [
          {
            id: 'msg-1',
            threadId: 'thread-operator',
            nativeMessageId: 'msg-user',
            nativeTurnId: 'turn-1',
            role: 'user',
            phase: 'input',
            content: 'Existing instruction',
            createdAt: 3,
            tokenInput: null,
            tokenOutput: null,
            rawRef: null,
            rawJson: null,
            sourceChecksum: null,
            sequence: 1,
          },
        ],
      },
      runs: [],
      projects: [],
    };
    ipc = {
      getThread: vi.fn().mockResolvedValue({ success: true, data: response }),
      sendMessage: vi.fn().mockResolvedValue({ success: true, data: { ...response, run: null } }),
      listRuns: vi.fn(),
      listProjects: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [OperatorPageComponent],
      providers: [
        provideRouter([]),
        { provide: OperatorIpcService, useValue: ipc },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(OperatorPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('renders the persisted operator transcript', () => {
    expect(fixture.nativeElement.textContent).toContain('Existing instruction');
    expect(fixture.nativeElement.textContent).toContain('Orchestrator');
  });

  it('submits composer text through the operator store', async () => {
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Coordinate releases';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement;
    button.click();
    await fixture.whenStable();

    expect(ipc.sendMessage).toHaveBeenCalledWith({ text: 'Coordinate releases' });
  });
});
