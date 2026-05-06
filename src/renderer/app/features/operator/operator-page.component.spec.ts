import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationLedgerConversation } from '../../../../shared/types/conversation-ledger.types';
import type { OperatorRunGraph, OperatorRunRecord } from '../../../../shared/types/operator.types';
import { OperatorIpcService } from '../../core/services/ipc/operator-ipc.service';
import { OperatorStore } from '../../core/state/operator.store';
import { OperatorPageComponent } from './operator-page.component';

describe('OperatorPageComponent', () => {
  let fixture: ComponentFixture<OperatorPageComponent>;
  let ipc: {
    getThread: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    listRuns: ReturnType<typeof vi.fn>;
    getRun: ReturnType<typeof vi.fn>;
    listProjects: ReturnType<typeof vi.fn>;
    rescanProjects: ReturnType<typeof vi.fn>;
    cancelRun: ReturnType<typeof vi.fn>;
    retryRun: ReturnType<typeof vi.fn>;
    onOperatorEvent: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    const response: ConversationLedgerConversation = {
      thread: {
        id: 'thread-operator',
        provider: 'orchestrator',
        nativeThreadId: 'orchestrator-global',
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
    };
    ipc = {
      getThread: vi.fn().mockResolvedValue({ success: true, data: response }),
      sendMessage: vi.fn().mockResolvedValue({ success: true, data: response }),
      listRuns: vi.fn().mockResolvedValue({ success: true, data: [makeRun()] }),
      getRun: vi.fn().mockResolvedValue({ success: true, data: makeRunGraph(makeRun()) }),
      listProjects: vi.fn().mockResolvedValue({ success: true, data: [] }),
      rescanProjects: vi.fn().mockResolvedValue({ success: true, data: [] }),
      cancelRun: vi.fn().mockResolvedValue({ success: true, data: null }),
      retryRun: vi.fn().mockResolvedValue({ success: true, data: null }),
      onOperatorEvent: vi.fn().mockReturnValue(() => { /* noop */ }),
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
    await TestBed.inject(OperatorStore).initialize();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('renders the persisted operator transcript', () => {
    expect(fixture.nativeElement.textContent).toContain('Existing instruction');
    expect(fixture.nativeElement.textContent).toContain('Orchestrator');
  });

  it('renders active run graph details', () => {
    expect(fixture.nativeElement.textContent).toContain('Run graph');
    expect(fixture.nativeElement.textContent).toContain('Pull repositories');
    expect(fixture.nativeElement.textContent).toContain('project-agent');
  });

  it('renders changed files, verification checks, child refs, and artifact events', () => {
    const text = fixture.nativeElement.textContent;

    expect(text).toContain('Changed files');
    expect(text).toContain('src/main/voice.ts');
    expect(text).toContain('Verification');
    expect(text).toContain('npx tsc --noEmit');
    expect(text).toContain('instance-1');
    expect(text).toContain('src/main/voice.ts modified');
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

function makeRun(): OperatorRunRecord {
  return {
    id: 'run-1',
    threadId: 'thread-operator',
    sourceMessageId: 'msg-1',
    title: 'Pull repositories',
    status: 'completed',
    autonomyMode: 'full',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 3,
    goal: 'Pull all repos',
    budget: {
      maxNodes: 50,
      maxRetries: 3,
      maxWallClockMs: 7200000,
      maxConcurrentNodes: 3,
    },
    usageJson: {
      nodesStarted: 2,
      nodesCompleted: 2,
      retriesUsed: 0,
      wallClockMs: 100,
    },
    planJson: { intent: 'workspace_git_batch', rootPath: '/work' },
    resultJson: {
      synthesis: {
        summaryMarkdown: 'Pulled 1 repositories.',
      },
    },
    error: null,
  };
}

function makeRunGraph(run: OperatorRunRecord): OperatorRunGraph {
  return {
    run,
    nodes: [
      {
        id: 'node-1',
        runId: run.id,
        parentNodeId: null,
        type: 'project-agent',
        status: 'completed',
        targetProjectId: 'project-1',
        targetPath: '/work/ai-orchestrator',
        title: 'Pull repositories',
        inputJson: { rootPath: '/work' },
        outputJson: {
          outputPreview: 'Implemented voice conversations.',
          changedFiles: ['/work/ai-orchestrator/src/main/voice.ts'],
        },
        externalRefKind: 'instance',
        externalRefId: 'instance-1',
        createdAt: 1,
        updatedAt: 2,
        completedAt: 3,
        error: null,
      },
      {
        id: 'node-2',
        runId: run.id,
        parentNodeId: 'node-1',
        type: 'verification',
        status: 'completed',
        targetProjectId: 'project-1',
        targetPath: '/work/ai-orchestrator',
        title: 'Verify AI Orchestrator',
        inputJson: { sourceNodeId: 'node-1' },
        outputJson: {
          status: 'passed',
          checks: [
            {
              label: 'TypeScript',
              command: 'npx',
              args: ['tsc', '--noEmit'],
              cwd: '/work/ai-orchestrator',
              required: true,
              status: 'passed',
              exitCode: 0,
              durationMs: 50,
              timedOut: false,
              stdoutBytes: 0,
              stderrBytes: 0,
              stdoutExcerpt: '',
              stderrExcerpt: '',
              error: null,
            },
          ],
        },
        externalRefKind: null,
        externalRefId: null,
        createdAt: 4,
        updatedAt: 5,
        completedAt: 6,
        error: null,
      },
    ],
    events: [
      {
        id: 'event-1',
        runId: run.id,
        nodeId: 'node-1',
        kind: 'fs-write',
        payload: {
          path: '/work/ai-orchestrator/src/main/voice.ts',
          bytesWritten: 128,
          sha256: 'abc123',
          kind: 'modify',
        },
        createdAt: 7,
      },
    ],
  };
}
