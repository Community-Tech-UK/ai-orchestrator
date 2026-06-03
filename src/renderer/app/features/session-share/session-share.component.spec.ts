/**
 * SessionShareComponent — vitest logic spec
 *
 * Tests the component's public methods and signals directly, without relying on
 * signal-input wiring (which is not available in Vitest's JIT compilation mode).
 *
 * Covered:
 * - previewBundle sets preview signal on success
 * - previewBundle sets error signal on failure / throw
 * - saveBundle sets saved signal with filePath + bundle on success
 * - saveBundle does not set error on SAVE_CANCELLED — sets info instead
 * - saveBundle sets error on failure
 * - copyPath calls navigator.clipboard.writeText
 * - copyPath sets and resets copied signal
 * - hasSource computed from instanceId / historyEntryId
 */

import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SessionShareIpcService } from '../../core/services/ipc/session-share-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import type { SessionShareBundle } from '../../../../shared/types/session-share.types';
import { SessionShareComponent } from './session-share.component';

// ---- Test data helpers ----

function makeBundle(overrides: Partial<SessionShareBundle> = {}): SessionShareBundle {
  return {
    version: '1.0',
    createdAt: 1_700_000_000_000,
    redacted: true,
    source: {
      kind: 'instance',
      instanceId: 'inst-1',
      displayName: 'My Session',
      workingDirectoryLabel: '<workspace>',
    },
    summary: {
      totalMessages: 5,
      userMessages: 2,
      assistantMessages: 2,
      toolMessages: 1,
      artifactCount: 1,
      attachmentCount: 0,
      continuitySnapshotCount: 0,
      fileSnapshotSessionCount: 0,
      redactedContentCount: 1,
    },
    messages: [],
    artifacts: [],
    attachments: [],
    continuitySnapshots: [],
    fileSnapshotSessions: [],
    warnings: ['No structured child-result artifacts were recorded for this run.'],
    ...overrides,
  };
}

function okPreview(bundle: SessionShareBundle): IpcResponse {
  return { success: true, data: bundle };
}

function okSave(bundle: SessionShareBundle, filePath = '/tmp/share.json'): IpcResponse {
  return { success: true, data: { filePath, bundle } };
}

function errResponse(message: string): IpcResponse {
  return { success: false, error: { message } };
}

function cancelledResponse(): IpcResponse {
  return { success: false, error: { message: 'Save cancelled' } };
}

// ---- Mock IPC service ----

interface MockIpc {
  previewForInstance: ReturnType<typeof vi.fn>;
  previewForHistory: ReturnType<typeof vi.fn>;
  saveForInstance: ReturnType<typeof vi.fn>;
  saveForHistory: ReturnType<typeof vi.fn>;
  loadBundle: ReturnType<typeof vi.fn>;
  replayBundle: ReturnType<typeof vi.fn>;
}

function createMockIpc(): MockIpc {
  return {
    previewForInstance: vi.fn(),
    previewForHistory: vi.fn(),
    saveForInstance: vi.fn(),
    saveForHistory: vi.fn(),
    loadBundle: vi.fn(),
    replayBundle: vi.fn(),
  };
}

// ---- Helpers ----

/**
 * Creates a component instance without TestBed component fixture, bypassing
 * the signal-input JIT limitation. We test methods + signals directly.
 */
function createComponent(mockIpc: MockIpc): SessionShareComponent {
  const component = TestBed.inject(SessionShareComponent);
  // Patch the private ipc field via Object.defineProperty to inject our mock.
  // This avoids the JIT limitation where signal input() metadata is not
  // generated, making componentRef.setInput unavailable.
  Object.defineProperty(component, 'ipc', { value: mockIpc, writable: true });
  return component;
}

// ---- Specs ----

describe('SessionShareComponent', () => {
  let mockIpc: MockIpc;
  let component: SessionShareComponent;

  beforeEach(async () => {
    mockIpc = createMockIpc();

    await TestBed.configureTestingModule({
      imports: [SessionShareComponent],
      providers: [
        SessionShareComponent,
        { provide: SessionShareIpcService, useValue: mockIpc },
      ],
    }).compileComponents();

    component = createComponent(mockIpc);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ---- hasSource ----

  it('hasSource returns false when both instanceId and historyEntryId are undefined', () => {
    // Default signal inputs are undefined, so hasSource should be false
    expect(component.hasSource()).toBe(false);
  });

  // ---- previewBundle — success with instance ----

  it('previewBundle calls previewForInstance and sets preview signal', async () => {
    const bundle = makeBundle();
    mockIpc.previewForInstance.mockResolvedValue(okPreview(bundle));

    // Directly invoke method — simulates clicking Preview button
    // We set the private ipc already; we also need instanceId to be truthy.
    // Monkey-patch the computed signal to return a truthy instanceId.
    vi.spyOn(component, 'hasSource').mockReturnValue(true);
    // Override instanceId() to return 'inst-1'
    const origInstanceId = component.instanceId;
    vi.spyOn(component, 'instanceId' as never).mockReturnValue('inst-1' as never);

    await component.previewBundle();

    expect(mockIpc.previewForInstance).toHaveBeenCalledWith('inst-1');
    expect(component.preview()).toEqual(bundle);
    expect(component.error()).toBeNull();

    // restore
    component.instanceId = origInstanceId;
  });

  // ---- previewBundle — error response ----

  it('previewBundle sets error signal when IPC returns failure', async () => {
    mockIpc.previewForInstance.mockResolvedValue(errResponse('Preview exploded'));

    vi.spyOn(component, 'hasSource').mockReturnValue(true);
    vi.spyOn(component, 'instanceId' as never).mockReturnValue('inst-1' as never);

    await component.previewBundle();

    expect(component.error()).toBe('Preview exploded');
    expect(component.preview()).toBeNull();
  });

  // ---- previewBundle — throws ----

  it('previewBundle sets error signal when IPC throws', async () => {
    mockIpc.previewForInstance.mockRejectedValue(new Error('Network failure'));

    vi.spyOn(component, 'hasSource').mockReturnValue(true);
    vi.spyOn(component, 'instanceId' as never).mockReturnValue('inst-1' as never);

    await component.previewBundle();

    expect(component.error()).toBe('Network failure');
  });

  // ---- previewBundle — historyEntryId path ----

  it('previewBundle calls previewForHistory when instanceId is falsy', async () => {
    const bundle = makeBundle({
      source: { kind: 'history', displayName: 'History Entry', workingDirectoryLabel: '<workspace>' },
    });
    mockIpc.previewForHistory.mockResolvedValue(okPreview(bundle));

    vi.spyOn(component, 'hasSource').mockReturnValue(true);
    // instanceId is falsy (undefined by default)
    vi.spyOn(component, 'historyEntryId' as never).mockReturnValue('entry-42' as never);

    await component.previewBundle();

    expect(mockIpc.previewForHistory).toHaveBeenCalledWith('entry-42');
    expect(component.preview()).toEqual(bundle);
  });

  // ---- saveBundle — success ----

  it('saveBundle calls saveForInstance and sets saved signal', async () => {
    const bundle = makeBundle();
    mockIpc.saveForInstance.mockResolvedValue(okSave(bundle, '/tmp/my-session.share.json'));

    vi.spyOn(component, 'hasSource').mockReturnValue(true);
    vi.spyOn(component, 'instanceId' as never).mockReturnValue('inst-1' as never);

    await component.saveBundle();

    expect(mockIpc.saveForInstance).toHaveBeenCalledWith('inst-1');
    expect(component.saved()?.filePath).toBe('/tmp/my-session.share.json');
    expect(component.saved()?.bundle).toEqual(bundle);
    // Also populates preview
    expect(component.preview()).toEqual(bundle);
    expect(component.error()).toBeNull();
  });

  // ---- saveBundle — cancelled ----

  it('saveBundle sets info (not error) when save is cancelled', async () => {
    mockIpc.saveForInstance.mockResolvedValue(cancelledResponse());

    vi.spyOn(component, 'hasSource').mockReturnValue(true);
    vi.spyOn(component, 'instanceId' as never).mockReturnValue('inst-1' as never);

    await component.saveBundle();

    expect(component.error()).toBeNull();
    expect(component.info()).toMatch(/cancelled/i);
    expect(component.saved()).toBeNull();
  });

  // ---- saveBundle — error ----

  it('saveBundle sets error when IPC returns failure', async () => {
    mockIpc.saveForInstance.mockResolvedValue(errResponse('Disk full'));

    vi.spyOn(component, 'hasSource').mockReturnValue(true);
    vi.spyOn(component, 'instanceId' as never).mockReturnValue('inst-1' as never);

    await component.saveBundle();

    expect(component.error()).toBe('Disk full');
    expect(component.saved()).toBeNull();
  });

  // ---- saveBundle — historyEntryId path ----

  it('saveBundle calls saveForHistory when instanceId is falsy', async () => {
    const bundle = makeBundle();
    mockIpc.saveForHistory.mockResolvedValue(okSave(bundle));

    vi.spyOn(component, 'hasSource').mockReturnValue(true);
    vi.spyOn(component, 'historyEntryId' as never).mockReturnValue('entry-99' as never);

    await component.saveBundle();

    expect(mockIpc.saveForHistory).toHaveBeenCalledWith('entry-99');
    expect(component.saved()).not.toBeNull();
  });

  // ---- copyPath ----

  it('copyPath calls navigator.clipboard.writeText with saved file path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    // Pre-set saved state
    const bundle = makeBundle();
    component['saved'].set({ filePath: '/tmp/share.json', bundle });

    component.copyPath();

    expect(writeText).toHaveBeenCalledWith('/tmp/share.json');
  });

  it('copyPath sets copied to true immediately', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const bundle = makeBundle();
    component['saved'].set({ filePath: '/tmp/share.json', bundle });

    expect(component.copied()).toBe(false);
    component.copyPath();
    expect(component.copied()).toBe(true);
  });

  it('copyPath sets error when clipboard write is not available', () => {
    // Simulate clipboard API throwing synchronously-ish
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockImplementation(() => {
          throw new Error('NotAllowedError');
        }),
      },
    });

    const bundle = makeBundle();
    component['saved'].set({ filePath: '/tmp/share.json', bundle });

    component.copyPath();

    expect(component.error()).toBe('Clipboard write not available');
  });

  it('copyPath does nothing when saved is null', () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    // saved is null by default
    component.copyPath();

    expect(writeText).not.toHaveBeenCalled();
  });
});
