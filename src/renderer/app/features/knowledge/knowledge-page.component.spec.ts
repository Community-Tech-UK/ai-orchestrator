import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeStore } from '../../core/state/knowledge.store';
import { SettingsStore } from '../../core/state/settings.store';
import type {
  CodebaseMiningStatus,
  KGStats,
  ProjectKnowledgeProjectSummary,
  ProjectKnowledgeReadModel,
} from '../../../../shared/types/knowledge-graph.types';
import { KnowledgePageComponent } from './knowledge-page.component';

describe('KnowledgePageComponent', () => {
  let fixture: ComponentFixture<KnowledgePageComponent>;
  let miningStatus: WritableSignal<CodebaseMiningStatus | null>;
  let loading: WritableSignal<boolean>;
  let knowledgeStore: MockKnowledgeStore;

  beforeEach(async () => {
    miningStatus = signal<CodebaseMiningStatus | null>(null);
    loading = signal(false);
    knowledgeStore = createKnowledgeStoreMock(miningStatus, loading);

    await TestBed.configureTestingModule({
      imports: [KnowledgePageComponent],
      providers: [
        { provide: KnowledgeStore, useValue: knowledgeStore },
        { provide: SettingsStore, useValue: createSettingsStoreMock() },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(KnowledgePageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('renders a pause action for an active project and dispatches it for the current directory', async () => {
    miningStatus.set(makeMiningStatus({ isPaused: false }));
    fixture.detectChanges();
    setMineDirectory('/fake/project');

    clickMineAction('Pause');
    await fixture.whenStable();

    expect(knowledgeStore.pauseMining).toHaveBeenCalledWith('/fake/project');
    expect(mineAction('Resume')).toBeNull();
  });

  it('renders a resume action for a paused project and dispatches it for the current directory', async () => {
    miningStatus.set(makeMiningStatus({ isPaused: true }));
    fixture.detectChanges();
    setMineDirectory('/fake/project');

    clickMineAction('Resume');
    await fixture.whenStable();

    expect(knowledgeStore.resumeMining).toHaveBeenCalledWith('/fake/project');
    expect(mineAction('Pause')).toBeNull();
  });

  it('disables manual mining and hides pause controls for an excluded project', () => {
    miningStatus.set(makeMiningStatus({ isExcluded: true }));
    fixture.detectChanges();
    setMineDirectory('/fake/project');

    expect(mineAction('Mine')?.disabled).toBe(true);
    expect(mineAction('Pause')).toBeNull();
    expect(mineAction('Resume')).toBeNull();
    expect(mineAction('Exclude')).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Excluded');
  });

  it('dispatches exclude for the current directory', async () => {
    miningStatus.set(makeMiningStatus());
    fixture.detectChanges();
    setMineDirectory('/fake/project');

    clickMineAction('Exclude');
    await fixture.whenStable();

    expect(knowledgeStore.excludeMining).toHaveBeenCalledWith('/fake/project');
  });

  it('renders project summaries and dispatches project selection', async () => {
    fixture.detectChanges();

    const select = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>('select');
    expect(select).not.toBeNull();
    select!.value = select!.options[0].value;
    select!.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Evidence links');
    expect(knowledgeStore.selectProject).toHaveBeenCalledWith('/fake/project');
  });

  it('loads evidence for a selected project fact', async () => {
    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
    ).find((candidate) => candidate.textContent?.trim() === 'Evidence');
    expect(button).not.toBeNull();

    button!.click();
    await fixture.whenStable();

    expect(knowledgeStore.loadProjectEvidence).toHaveBeenCalledWith('kg_triple', 'triple-1');
  });

  it('renders code symbols and loads definition-location evidence', async () => {
    fixture.detectChanges();

    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
    ).find((candidate) => candidate.textContent?.trim() === 'Evidence' && candidate.parentElement?.textContent?.includes('bootstrap'));
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Showing 1 of 1');
    expect(button).not.toBeNull();

    button!.click();
    await fixture.whenStable();

    expect(knowledgeStore.loadProjectEvidence).toHaveBeenCalledWith('code_symbol', 'symbol-1');
  });

  it('dispatches code re-index for the selected project', async () => {
    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
    ).find((candidate) => candidate.textContent?.trim() === 'Re-index code');
    expect(button).not.toBeNull();

    button!.click();
    await fixture.whenStable();

    expect(knowledgeStore.refreshProjectCodeIndex).toHaveBeenCalledWith('/fake/project');
  });

  function setMineDirectory(dirPath: string): void {
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('.mine-actions input');
    expect(input).not.toBeNull();
    input!.value = dirPath;
    input!.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function mineAction(label: string): HTMLButtonElement | null {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.mine-actions button'),
    ).find((button) => button.textContent?.trim() === label) ?? null;
  }

  function clickMineAction(label: string): void {
    const button = mineAction(label);
    expect(button).not.toBeNull();
    button!.click();
  }
});

interface MockKnowledgeStore {
  stats: ReturnType<typeof signal<KGStats | null>>;
  entityFacts: ReturnType<typeof signal<unknown[]>>;
  timeline: ReturnType<typeof signal<unknown[]>>;
  selectedEntity: ReturnType<typeof signal<string>>;
  recentFacts: ReturnType<typeof signal<unknown[]>>;
  miningStatus: ReturnType<typeof signal<CodebaseMiningStatus | null>>;
  relationshipResults: ReturnType<typeof signal<unknown[]>>;
  projectSummaries: ReturnType<typeof signal<ProjectKnowledgeProjectSummary[]>>;
  selectedProjectKey: ReturnType<typeof signal<string>>;
  selectedProjectSummary: ReturnType<typeof signal<ProjectKnowledgeProjectSummary | null>>;
  projectReadModel: ReturnType<typeof signal<ProjectKnowledgeReadModel | null>>;
  selectedEvidence: ReturnType<typeof signal<unknown[]>>;
  selectedPredicate: ReturnType<typeof signal<string>>;
  loading: ReturnType<typeof signal<boolean>>;
  error: ReturnType<typeof signal<string | null>>;
  loadStats: ReturnType<typeof vi.fn>;
  loadWakeContext: ReturnType<typeof vi.fn>;
  checkMiningStatus: ReturnType<typeof vi.fn>;
  clearError: ReturnType<typeof vi.fn>;
  setError: ReturnType<typeof vi.fn>;
  queryEntity: ReturnType<typeof vi.fn>;
  loadTimeline: ReturnType<typeof vi.fn>;
  triggerMining: ReturnType<typeof vi.fn>;
  pauseMining: ReturnType<typeof vi.fn>;
  resumeMining: ReturnType<typeof vi.fn>;
  excludeMining: ReturnType<typeof vi.fn>;
  loadProjectKnowledgeProjects: ReturnType<typeof vi.fn>;
  selectProject: ReturnType<typeof vi.fn>;
  refreshProjectKnowledgeReadModel: ReturnType<typeof vi.fn>;
  refreshProjectCodeIndex: ReturnType<typeof vi.fn>;
  loadProjectEvidence: ReturnType<typeof vi.fn>;
  addFact: ReturnType<typeof vi.fn>;
  invalidateFact: ReturnType<typeof vi.fn>;
  queryRelationship: ReturnType<typeof vi.fn>;
}

function createKnowledgeStoreMock(
  miningStatus: WritableSignal<CodebaseMiningStatus | null>,
  loading: WritableSignal<boolean>,
): MockKnowledgeStore {
  return {
    stats: signal<KGStats | null>({
      entities: 0,
      triples: 0,
      currentFacts: 0,
      expiredFacts: 0,
      relationshipTypes: [],
    }),
    entityFacts: signal<unknown[]>([]),
    timeline: signal<unknown[]>([]),
    selectedEntity: signal(''),
    recentFacts: signal<unknown[]>([]),
    miningStatus,
    relationshipResults: signal<unknown[]>([]),
    projectSummaries: signal<ProjectKnowledgeProjectSummary[]>([makeProjectSummary()]),
    selectedProjectKey: signal('/fake/project'),
    selectedProjectSummary: signal<ProjectKnowledgeProjectSummary | null>(makeProjectSummary()),
    projectReadModel: signal<ProjectKnowledgeReadModel | null>(makeReadModel()),
    selectedEvidence: signal<unknown[]>([]),
    selectedPredicate: signal(''),
    loading,
    error: signal<string | null>(null),
    loadStats: vi.fn().mockResolvedValue(undefined),
    loadWakeContext: vi.fn().mockResolvedValue(undefined),
    checkMiningStatus: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(),
    setError: vi.fn(),
    queryEntity: vi.fn().mockResolvedValue(undefined),
    loadTimeline: vi.fn().mockResolvedValue(undefined),
    triggerMining: vi.fn().mockResolvedValue(undefined),
    pauseMining: vi.fn().mockResolvedValue(undefined),
    resumeMining: vi.fn().mockResolvedValue(undefined),
    excludeMining: vi.fn().mockResolvedValue(undefined),
    loadProjectKnowledgeProjects: vi.fn().mockResolvedValue(undefined),
    selectProject: vi.fn().mockResolvedValue(undefined),
    refreshProjectKnowledgeReadModel: vi.fn().mockResolvedValue(undefined),
    refreshProjectCodeIndex: vi.fn().mockResolvedValue(undefined),
    loadProjectEvidence: vi.fn().mockResolvedValue(undefined),
    addFact: vi.fn().mockResolvedValue(true),
    invalidateFact: vi.fn().mockResolvedValue(undefined),
    queryRelationship: vi.fn().mockResolvedValue(undefined),
  };
}

function makeProjectSummary(): ProjectKnowledgeProjectSummary {
  const mining = makeMiningStatus();
  return {
    projectKey: '/fake/project',
    rootPath: '/fake/project',
    displayName: 'project',
    miningStatus: mining,
    inventory: {
      totalSources: 1,
      totalLinks: 1,
      totalKgLinks: 1,
      totalWakeLinks: 0,
      totalCodeSymbols: 1,
      byKind: { manifest: 1 },
    },
  };
}

function makeReadModel(): ProjectKnowledgeReadModel {
  return {
    project: makeProjectSummary(),
    sources: [
      {
        id: 'source-1',
        projectKey: '/fake/project',
        sourceKind: 'manifest',
        sourceUri: '/fake/project/package.json',
        sourceTitle: 'package.json',
        contentFingerprint: 'hash',
        createdAt: 1,
        updatedAt: 1,
        lastSeenAt: 1,
        metadata: {},
      },
    ],
    facts: [
      {
        targetKind: 'kg_triple',
        targetId: 'triple-1',
        subject: 'project',
        predicate: 'uses_backend',
        object: 'express',
        confidence: 1,
        validFrom: null,
        validTo: null,
        sourceFile: '/fake/project/package.json',
        evidenceCount: 1,
      },
    ],
    wakeHints: [],
    codeIndex: {
      projectKey: '/fake/project',
      workspaceHash: 'workspace-1',
      status: 'ready',
      fileCount: 1,
      symbolCount: 1,
      lastIndexedAt: 1,
      lastSyncedAt: 1,
      updatedAt: 1,
      metadata: { snapshotVersion: 1 },
    },
    codeSymbols: [
      {
        targetKind: 'code_symbol',
        targetId: 'symbol-1',
        id: 'pcs_1',
        projectKey: '/fake/project',
        sourceId: 'source-1',
        workspaceHash: 'workspace-1',
        symbolId: 'symbol-1',
        pathFromRoot: 'src/main.ts',
        name: 'bootstrap',
        kind: 'function',
        startLine: 12,
        startCharacter: 0,
        endLine: 12,
        endCharacter: 9,
        createdAt: 1,
        updatedAt: 1,
        metadata: { snapshotVersion: 1 },
        evidenceCount: 1,
      },
    ],
  };
}

function createSettingsStoreMock(): { defaultWorkingDirectory: () => string; initialize: ReturnType<typeof vi.fn> } {
  return {
    defaultWorkingDirectory: () => '',
    initialize: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMiningStatus(overrides: Partial<CodebaseMiningStatus> = {}): CodebaseMiningStatus {
  return {
    normalizedPath: '/fake/project',
    rootPath: '/fake/project',
    projectKey: '/fake/project',
    displayName: 'project',
    discoverySource: 'manual-browse',
    autoMine: true,
    isPaused: false,
    isExcluded: false,
    mined: true,
    status: 'completed',
    filesRead: 3,
    factsExtracted: 2,
    hintsCreated: 1,
    errors: [],
    updatedAt: 1_900_000_000_000,
    ...overrides,
  };
}
