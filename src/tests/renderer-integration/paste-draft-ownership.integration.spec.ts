import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { type ProviderToken, type WritableSignal, signal, ɵresolveComponentResources as resolveResources } from '@angular/core';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { DropZoneComponent } from '../../renderer/app/features/file-drop/drop-zone.component';
import { InstanceDetailComponent } from '../../renderer/app/features/instance-detail/instance-detail.component';
import { InstanceWelcomeComponent } from '../../renderer/app/features/instance-detail/instance-welcome.component';
import { ChatDetailComponent } from '../../renderer/app/features/chats/chat-detail.component';
import { DraftService } from '../../renderer/app/core/services/draft.service';
import { NewSessionDraftService } from '../../renderer/app/core/services/new-session-draft.service';
import { ToastService } from '../../renderer/app/core/services/toast.service';
import { InstanceStore } from '../../renderer/app/core/state/instance.store';
import { HistoryStore } from '../../renderer/app/core/state/history.store';
import { SettingsStore } from '../../renderer/app/core/state/settings.store';
import { IpcFacadeService, RecentDirectoriesIpcService, VcsIpcService, OrchestrationIpcService } from '../../renderer/app/core/services/ipc';
import { ProviderIpcService } from '../../renderer/app/core/services/ipc/provider-ipc.service';
import { CrossModelReviewIpcService } from '../../renderer/app/core/services/ipc/cross-model-review-ipc.service';
import { HistoryIpcService } from '../../renderer/app/core/services/ipc/history-ipc.service';
import { QuickActionDispatcherService } from '../../renderer/app/features/orchestration/quick-action-dispatcher.service';
import { LoopStopConfirmService } from '../../renderer/app/features/loop/loop-stop-confirm.service';
import { LoopStore } from '../../renderer/app/core/state/loop.store';
import { LoopPromptHistoryService } from '../../renderer/app/features/loop/loop-prompt-history.service';
import { AutomationStore } from '../../renderer/app/core/state/automation.store';
import { TodoStore } from '../../renderer/app/core/state/todo.store';
import { WelcomeCoordinatorService } from '../../renderer/app/features/instance-detail/welcome-coordinator.service';
import { HistoryPreviewSessionService } from '../../renderer/app/features/instance-detail/history-preview-session.service';
import { FileAttachmentService } from '../../renderer/app/features/instance-detail/file-attachment.service';
import { UnifiedCatalogStore } from '../../renderer/app/features/models/unified-catalog.store';
import { ColdCacheResumeService } from '../../renderer/app/features/instance-detail/cold-cache-resume.service';
import { RemoteNodeStore } from '../../renderer/app/core/state/remote-node.store';
import { ProviderStateService } from '../../renderer/app/core/services/provider-state.service';
import { WorkspaceIpcService } from '../../renderer/app/core/services/ipc/workspace-ipc.service';
import { ScratchDirectoryService } from '../../renderer/app/core/services/scratch-directory.service';
import { ChatStore } from '../../renderer/app/core/state/chat.store';
import { InstanceListStore } from '../../renderer/app/core/state/instance/instance-list.store';
import { FileIpcService } from '../../renderer/app/core/services/ipc/file-ipc.service';
import { OperatorIpcService } from '../../renderer/app/core/services/ipc/operator-ipc.service';
const originalArrayBuffer = Object.getOwnPropertyDescriptor(File.prototype, 'arrayBuffer');
await resolveResources(() => Promise.resolve(''));
const detailTemplate = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../renderer/app/features/instance-detail/instance-detail.component.html'), 'utf8');
const chatTemplate = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../renderer/app/features/chats/chat-detail.component.html'), 'utf8');
function opening(source: string, index = 0) { return [...source.matchAll(/<app-drop-zone[\s\S]*?>/g)][index][0]; }
const detailPasteTemplate = `@if(instance()){${opening(detailTemplate)}<textarea></textarea></app-drop-zone>} @else if(historyPreview()){${opening(detailTemplate, 1)}<textarea></textarea></app-drop-zone>} @else {${detailTemplate.match(/<app-instance-welcome[\s\S]*?\/>/)![0]}}`;
const chatPasteTemplate = `@if(detail()){${opening(chatTemplate)}<textarea></textarea></app-drop-zone>}`;
const originalWelcome = (InstanceWelcomeComponent as unknown as { __annotations__: { template: string }[] }).__annotations__[0].template;
const welcomePasteTemplate = opening(originalWelcome) + '<textarea></textarea></app-drop-zone>';
let selected: WritableSignal<ReturnType<typeof instance> | null>;
let history: WritableSignal<ReturnType<typeof conversation> | null>;
let chats: WritableSignal<ReturnType<typeof chat> | null>;
let fixture: ComponentFixture<InstanceDetailComponent | ChatDetailComponent | DropZoneComponent> | null = null;
let drafts: DraftService;
let newDraft: NewSessionDraftService;
const toast = vi.fn();
const instance = (id: string) => ({ id, provider: 'claude', status: 'idle', childrenIds: [], contextUsage: { percentage: 0 }, outputBuffer: [], restartEpoch: 0 });
const conversation = (id: string) => ({ entry: { id, title: id, provider: 'claude', workingDirectory: '/fixture' }, messages: [] });
const chat = (id: string) => ({ chat: { id, name: id, ledgerThreadId: id, currentCwd: '/fixture' }, conversation: { messages: [] } });
beforeEach(async () => {
    TestBed.resetTestingModule();
    window.localStorage.clear();
    toast.mockReset();
    Object.defineProperty(File.prototype, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer, writable: true, configurable: true });
    selected = signal(instance('A'));
    history = signal(null);
    chats = signal(chat('A'));
    const store = { selectedInstance: selected, selectedInstanceIdentity: () => selected()?.id ?? null, selectedInstanceSessionId: () => null, selectedInstanceActivity: signal(null), getSelectedInstanceBusySince: () => null, getQueuedMessageCount: () => 0, getMessageQueue: () => [], isInstanceCompacting: () => false, getInstance: () => null };
    const settings = { showThinking: signal(false), thinkingDefaultExpanded: signal(false), showToolMessages: signal(false), defaultWorkingDirectory: signal(null), settings: signal({}) };
    const value = (provide: ProviderToken<unknown>, useValue: unknown) => ({ provide, useValue });
    TestBed.overrideComponent(InstanceDetailComponent, { set: { template: detailPasteTemplate, templateUrl: undefined, styleUrl: undefined, styles: [], imports: [DropZoneComponent, InstanceWelcomeComponent] } });
    TestBed.overrideComponent(InstanceWelcomeComponent, { set: { template: welcomePasteTemplate, imports: [DropZoneComponent], styles: [] } });
    TestBed.overrideComponent(ChatDetailComponent, { set: { template: chatPasteTemplate, templateUrl: undefined, styleUrl: undefined, styles: [], imports: [DropZoneComponent] } });
    await TestBed.configureTestingModule({ imports: [InstanceDetailComponent, ChatDetailComponent], providers: [DraftService, NewSessionDraftService, WelcomeCoordinatorService,
            value(ToastService, { show: toast }), value(InstanceStore, store), value(HistoryStore, { previewConversation: history }), value(SettingsStore, settings), value(Router, {}), value(IpcFacadeService, {}), value(RecentDirectoriesIpcService, { getDirectories: async () => [] }), value(ProviderIpcService, {}), value(CrossModelReviewIpcService, { getReviewForInstance: () => null }), value(HistoryIpcService, { listSessionSnapshots: async () => ({ success: true, data: [] }) }), value(QuickActionDispatcherService, {}), value(LoopStopConfirmService, {}), value(LoopStore, { outstanding: () => [], loadOutstanding: async () => undefined }), value(LoopPromptHistoryService, {}), value(AutomationStore, {}), value(TodoStore, { hasTodos: () => false, currentSessionId: () => null, setSession: async () => undefined }), value(FileAttachmentService, {}), value(UnifiedCatalogStore, { ensureLoaded: () => undefined }), value(ColdCacheResumeService, {}), value(HistoryPreviewSessionService, { isRestoring: () => false, error: () => null, selection: () => null }), value(RemoteNodeStore, {}), value(VcsIpcService, { vcsIsRepo: async () => ({ success: false }) }), value(OrchestrationIpcService, {}), value(ProviderStateService, { getLaunchModeForProvider: () => null, getProviderForCreation: () => null }), value(WorkspaceIpcService, { hintActive: async () => undefined }), value(ScratchDirectoryService, { init: async () => undefined, isScratch: () => true }), value(ChatStore, { selectedDetail: chats }), value(InstanceListStore, {}), value(FileIpcService, {}), value(OperatorIpcService, { onOperatorEvent: () => () => undefined, listRuns: async () => ({ success: true, data: [] }) })
        ] }).compileComponents();
    drafts = TestBed.inject(DraftService);
    newDraft = TestBed.inject(NewSessionDraftService);
});
afterEach(() => { fixture?.destroy(); fixture = null; TestBed.resetTestingModule(); vi.restoreAllMocks(); if (originalArrayBuffer)
    Object.defineProperty(File.prototype, 'arrayBuffer', originalArrayBuffer);
else
    Reflect.deleteProperty(File.prototype, 'arrayBuffer'); });
function mount(mode: string) { if (mode === 'history') {
    selected.set(null);
    history.set(conversation('A'));
} if (mode === 'welcome') {
    selected.set(null);
    newDraft.open('/fixture/A', null, { hintWorkspace: false });
} fixture = mode === 'chat' ? TestBed.createComponent(ChatDetailComponent) : TestBed.createComponent(InstanceDetailComponent); fixture.detectChanges(); return fixture.debugElement.query(By.directive(DropZoneComponent)).componentInstance as DropZoneComponent; }
function deferredPaste(zone: DropZoneComponent) { let resolve!: (bytes: ArrayBuffer) => void; let reject!: (err: Error) => void; const bytes = new Promise<ArrayBuffer>((yes, no) => { resolve = yes; reject = no; }); vi.spyOn(File.prototype, 'arrayBuffer').mockImplementation(() => bytes); const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent; Object.defineProperty(event, 'clipboardData', { value: { items: [{ type: 'image/png', getAsFile: () => new File(['image'], 'clipboard.png', { type: 'image/png' }) }], getData: () => '' } }); const preventDefault = vi.spyOn(event, 'preventDefault'); const handler = vi.spyOn(zone, 'onPaste'); fixture!.nativeElement.querySelector('.drop-zone').dispatchEvent(event); const pending = handler.mock.results.at(-1)!.value as Promise<void>; expect(preventDefault).toHaveBeenCalledTimes(1); return { pending, resolve: () => resolve(new Uint8Array([1, 2, 3]).buffer), reject: () => reject(new Error('inert byte read failure')) }; }
function files(mode: string, id: string) { if (mode === 'welcome') {
    newDraft.open('/fixture/' + id, null, { hintWorkspace: false });
    return newDraft.pendingFiles();
} return drafts.getPendingFiles(mode === 'history' ? 'history-preview:' + id : mode === 'chat' ? 'chat:' + id : id); }
function switchTo(mode: string, id: string | null) { if (mode === 'live')
    selected.set(id ? instance(id) : null); if (mode === 'history')
    history.set(id ? conversation(id) : null); if (mode === 'chat')
    chats.set(id ? chat(id) : null); if (mode === 'welcome')
    newDraft.open('/fixture/' + id, null, { hintWorkspace: false }); }
describe('actual mounted paste draft ownership', () => {
    for (const mode of ['live', 'history', 'chat', 'welcome']) {
        it(mode + ' cancels A to B before any render flush', async () => { const zone = mount(mode); const p = deferredPaste(zone); switchTo(mode, 'B'); p.resolve(); await p.pending; expect(files(mode, 'B')).toEqual([]); expect(files(mode, 'A')).toEqual([]); });
        it(mode + ' retains same owner and deduplicates real byte fingerprints', async () => { const zone = mount(mode); const p = deferredPaste(zone); p.resolve(); await p.pending; const again = deferredPaste(zone); again.resolve(); await again.pending; expect(files(mode, 'A')).toHaveLength(1); expect(toast).toHaveBeenCalledWith('Already attached.'); });
    }
    it('live A to null cannot emit pending work', async () => { const zone = mount('live'); const emit = vi.spyOn(zone.imagesPasted, 'emit'); const p = deferredPaste(zone); selected.set(null); p.resolve(); await p.pending; expect(emit).not.toHaveBeenCalled(); });
    it('destroyed zone cancels before touching its output', async () => { const zone = mount('live'); const emit = vi.spyOn(zone.imagesPasted, 'emit'); const p = deferredPaste(zone); fixture!.destroy(); p.resolve(); await p.pending; expect(emit).not.toHaveBeenCalled(); });
    it('chat A to null cancels pending work without a render flush', async () => { const zone = mount('chat'); const emit = vi.spyOn(zone.imagesPasted, 'emit'); const p = deferredPaste(zone); chats.set(null); p.resolve(); await p.pending; expect(emit).not.toHaveBeenCalled(); });
    it('default component-local consumer still receives the image', async () => { const localFixture = TestBed.createComponent(DropZoneComponent); fixture = localFixture; fixture.detectChanges(); const zone = localFixture.componentInstance; zone.imagesPasted.subscribe((files: File[]) => drafts.addPendingFiles('component-local', files)); const p = deferredPaste(zone); selected.set(instance('B')); p.resolve(); await p.pending; expect(drafts.getPendingFiles('component-local')).toHaveLength(1); });
    it('replacing the owner getter cancels the original operation even with an equal key', async () => { const localFixture = TestBed.createComponent(DropZoneComponent); fixture = localFixture; fixture.componentRef.setInput('pasteOwner', () => 'A'); fixture.detectChanges(); const zone = localFixture.componentInstance; const emit = vi.spyOn(zone.imagesPasted, 'emit'); const p = deferredPaste(zone); fixture.componentRef.setInput('pasteOwner', () => 'A'); p.resolve(); await p.pending; expect(emit).not.toHaveBeenCalled(); });
    it('same-owner read error keeps the metadata fallback attachment', async () => { const zone = mount('live'); const p = deferredPaste(zone); p.reject(); await p.pending; expect(files('live', 'A')).toHaveLength(1); });
});
