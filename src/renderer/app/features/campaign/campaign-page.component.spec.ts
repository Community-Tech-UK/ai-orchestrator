import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignRunDto, CampaignSpec } from '../../../../shared/types/campaign.types';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { CampaignStore } from '../../core/state/campaign.store';
import { CampaignPageComponent } from './campaign-page.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './campaign-page.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './campaign-page.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('campaign-page.component.html')) return Promise.resolve(template);
  if (url.endsWith('campaign-page.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('CampaignPageComponent editor', () => {
  let fixture: ComponentFixture<CampaignPageComponent>;
  let store: {
    allCampaigns: ReturnType<typeof signal<unknown[]>>;
    activeCampaigns: ReturnType<typeof signal<unknown[]>>;
    isLoading: ReturnType<typeof signal<boolean>>;
    lastError: ReturnType<typeof signal<string | null>>;
    ensureWired: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    validate: ReturnType<typeof vi.fn>;
    importPlanPreview: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    halt: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    store = {
      allCampaigns: signal([]),
      activeCampaigns: signal([]),
      isLoading: signal(false),
      lastError: signal(null),
      ensureWired: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
      validate: vi.fn().mockResolvedValue({ success: true, data: { valid: true, errors: [] } }),
      importPlanPreview: vi.fn(),
      start: vi.fn().mockResolvedValue({ success: true, data: { campaign: null } }),
      halt: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
    };

    await TestBed.configureTestingModule({
      imports: [CampaignPageComponent],
      providers: [
        { provide: CampaignStore, useValue: store },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CampaignPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('builds and runs a two-node campaign from the editor', async () => {
    const component = fixture.componentInstance as unknown as {
      addNodeAt: (x: number, y: number) => void;
      updateNode: (id: string, patch: Record<string, unknown>) => void;
      edgeFrom: { set: (value: string) => void };
      edgeTo: { set: (value: string) => void };
      addEdge: () => void;
      onRunCampaign: () => Promise<void>;
    };

    component.addNodeAt(360, 150);
    component.updateNode('node-1', {
      label: 'Implement',
      initialPrompt: 'Implement the feature',
      workspaceCwd: '/tmp/project',
      verifyCommand: 'npm test',
    });
    component.updateNode('node-2', {
      label: 'Review',
      initialPrompt: 'Review the implementation',
      workspaceCwd: '/tmp/project',
    });
    component.edgeFrom.set('node-1');
    component.edgeTo.set('node-2');
    component.addEdge();

    await component.onRunCampaign();

    expect(store.start).toHaveBeenCalledTimes(1);
    const spec = store.start.mock.calls[0][0] as CampaignSpec;
    expect(spec.nodes.map((n) => n.id)).toEqual(['node-1', 'node-2']);
    expect(spec.edges).toEqual([{ from: 'node-1', to: 'node-2' }]);
    expect(spec.nodes[0].loopConfig).toMatchObject({
      initialPrompt: 'Implement the feature',
      workspaceCwd: '/tmp/project',
      completion: expect.objectContaining({ verifyCommand: 'npm test' }),
    });
  });

  it('rejects a cycle before running the campaign', async () => {
    const component = fixture.componentInstance as unknown as {
      addNodeAt: (x: number, y: number) => void;
      edgeFrom: { set: (value: string) => void };
      edgeTo: { set: (value: string) => void };
      addEdge: () => void;
      editorError: () => string | null;
      onRunCampaign: () => Promise<void>;
    };

    component.addNodeAt(360, 150);
    component.edgeFrom.set('node-1');
    component.edgeTo.set('node-2');
    component.addEdge();
    component.edgeFrom.set('node-2');
    component.edgeTo.set('node-1');
    component.addEdge();

    expect(component.editorError()).toContain('cycle');
    await component.onRunCampaign();
    expect(store.start).not.toHaveBeenCalled();
  });

  it('includes worktree isolation in the campaign policy when enabled', async () => {
    const component = fixture.componentInstance as unknown as {
      isolationEnabled: { set: (value: boolean) => void };
      updateNode: (id: string, patch: Record<string, unknown>) => void;
      onRunCampaign: () => Promise<void>;
    };

    component.updateNode('node-1', {
      initialPrompt: 'Implement in isolation',
      workspaceCwd: '/tmp/project',
    });
    component.isolationEnabled.set(true);

    await component.onRunCampaign();

    const spec = store.start.mock.calls[0][0] as CampaignSpec;
    expect(spec.policy.isolation).toBe('worktree');
  });

  it('allocates a fresh node id after loading a campaign with non-contiguous ids', () => {
    const component = fixture.componentInstance as unknown as {
      loadSpec: (campaign: CampaignRunDto) => void;
      addNodeAt: (x: number, y: number) => void;
      nodes: () => { id: string }[];
    };

    component.loadSpec({
      id: 'campaign-loaded',
      spec: {
        id: 'campaign-loaded',
        title: 'Loaded campaign',
        nodes: [
          { id: 'node-1', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp/project' }, dependsOn: [] },
          { id: 'node-3', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp/project' }, dependsOn: [] },
        ],
        edges: [],
        policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 2 },
        createdAt: 1,
      },
      status: 'completed',
      nodeRuns: [],
      startedAt: 1,
      endedAt: 2,
    });

    component.addNodeAt(360, 150);

    expect(component.nodes().map((node) => node.id)).toEqual(['node-1', 'node-3', 'node-4']);
  });

  it('preserves multi-status edge predicates when loading and running a campaign copy', async () => {
    const component = fixture.componentInstance as unknown as {
      loadSpec: (campaign: CampaignRunDto) => void;
      onRunCampaign: () => Promise<void>;
    };

    component.loadSpec({
      id: 'campaign-loaded-in-edge',
      spec: {
        id: 'campaign-loaded-in-edge',
        title: 'Loaded campaign',
        nodes: [
          { id: 'node-1', loopConfig: { initialPrompt: 'A', workspaceCwd: '/tmp/project' }, dependsOn: [] },
          { id: 'node-2', loopConfig: { initialPrompt: 'B', workspaceCwd: '/tmp/project' }, dependsOn: ['node-1'] },
        ],
        edges: [{
          from: 'node-1',
          to: 'node-2',
          when: { type: 'in', statuses: ['completed', 'completed-needs-review'] },
        }],
        policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 2 },
        createdAt: 1,
      },
      status: 'completed',
      nodeRuns: [],
      startedAt: 1,
      endedAt: 2,
    });

    await component.onRunCampaign();

    const spec = store.start.mock.calls[0][0] as CampaignSpec;
    expect(spec.edges[0].when).toEqual({
      type: 'in',
      statuses: ['completed', 'completed-needs-review'],
    });
  });

  it('does not offer provider-limit as an edge terminal predicate', () => {
    const component = fixture.componentInstance as unknown as {
      terminalStatuses: string[];
    };

    expect(component.terminalStatuses).not.toContain('provider-limit');
    expect(component.terminalStatuses).toContain('failed');
  });
});

describe('CampaignPageComponent — WS8 plan import', () => {
  let fixture: ComponentFixture<CampaignPageComponent>;
  let store: {
    allCampaigns: ReturnType<typeof signal<unknown[]>>;
    activeCampaigns: ReturnType<typeof signal<unknown[]>>;
    isLoading: ReturnType<typeof signal<boolean>>;
    lastError: ReturnType<typeof signal<string | null>>;
    ensureWired: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    validate: ReturnType<typeof vi.fn>;
    importPlanPreview: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    halt: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };

  const generatedSpec: CampaignSpec = {
    id: 'plan-abcd1234-1',
    title: 'Plan campaign: docs/plans/big.md',
    nodes: [
      {
        id: 'ws1',
        label: 'WS1 — Parser',
        dependsOn: [],
        loopConfig: {
          initialPrompt: 'implement ONLY WS1',
          workspaceCwd: '/repo',
          maxTurnsPerIteration: 30,
          caps: { maxIterations: 50, maxWallTimeMs: 1, maxTokens: null, maxCostCents: 3000, maxToolCallsPerIteration: 200 },
          completion: { verifyCommand: 'npm test', requireCompletedFileRename: false },
        },
      },
      {
        id: 'integration-gate',
        label: 'Integration gate',
        dependsOn: ['ws1'],
        loopConfig: {
          initialPrompt: 'verify + rename',
          workspaceCwd: '/repo',
          maxTurnsPerIteration: 30,
          caps: { maxIterations: 50, maxWallTimeMs: 1, maxTokens: null, maxCostCents: 3000, maxToolCallsPerIteration: 200 },
          completion: { verifyCommand: 'npm test', requireCompletedFileRename: true },
        },
      },
    ],
    edges: [{ from: 'ws1', to: 'integration-gate', when: { type: 'is', status: 'completed' } }],
    policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 1 },
    createdAt: 1,
    sourceRef: 'docs/plans/big.md',
    sourceDigest: 'a'.repeat(64),
  };

  beforeEach(async () => {
    store = {
      allCampaigns: signal([]),
      activeCampaigns: signal([]),
      isLoading: signal(false),
      lastError: signal(null),
      ensureWired: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
      validate: vi.fn().mockResolvedValue({ success: true, data: { valid: true, errors: [] } }),
      importPlanPreview: vi.fn().mockResolvedValue({
        success: true,
        data: {
          spec: generatedSpec,
          sourceDigest: generatedSpec.sourceDigest,
          aggregateMaxCostCents: 6000,
          assessment: {
            disposition: 'campaign-required',
            reasons: ['multiple-workstreams'],
            workstreams: [{ id: 'WS1', title: 'Parser' }],
          },
        },
      }),
      start: vi.fn().mockResolvedValue({ success: true, data: { campaign: null } }),
      halt: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
    };
    await TestBed.configureTestingModule({
      imports: [CampaignPageComponent],
      providers: [
        { provide: CampaignStore, useValue: store },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({ planFile: 'docs/plans/big.md', workspaceCwd: '/repo' }) } },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(CampaignPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('prefills the plan path from query params (loop-panel navigation action)', () => {
    expect(fixture.componentInstance.importPlanFile()).toBe('docs/plans/big.md');
    expect(fixture.componentInstance.importWorkspaceCwd()).toBe('/repo');
  });

  it('preview loads the generated spec and required policy WITHOUT auto-starting', async () => {
    const component = fixture.componentInstance;
    component.importVerifyCommand.set('npm test');

    await component.onImportPlanPreview();
    fixture.detectChanges();

    expect(store.importPlanPreview).toHaveBeenCalledWith({
      workspaceCwd: '/repo',
      planFile: 'docs/plans/big.md',
      baseLoop: { verifyCommand: 'npm test' },
    });
    // Import NEVER starts the campaign.
    expect(store.start).not.toHaveBeenCalled();
    // Required policy fields are loaded and visible in the editor state.
    expect(component.maxParallel()).toBe(1);
    expect(component.onNodeNeedsReview()).toBe('pause-campaign');
    expect(component.isolationEnabled()).toBe(false);
    expect(component.importPreview()?.aggregateMaxCostCents).toBe(6000);
    expect(component.importPreview()?.perNodeCapCents).toBe(3000);
    // The preview copy is rendered.
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('integration gate');
    expect(text).toContain('worst-case aggregate');
  });

  it('running a pristine import starts the GENERATED spec (digest included)', async () => {
    const component = fixture.componentInstance;
    await component.onImportPlanPreview();

    await component.onRunCampaign();

    expect(store.start).toHaveBeenCalledTimes(1);
    const started = store.start.mock.calls[0][0] as CampaignSpec;
    expect(started.sourceDigest).toBe('a'.repeat(64));
    expect(started.nodes.at(-1)?.loopConfig.completion?.requireCompletedFileRename).toBe(true);
  });

  it('editing the campaign invalidates the import (falls back to the editor spec)', async () => {
    const component = fixture.componentInstance;
    await component.onImportPlanPreview();

    component.updateNode('ws1', { label: 'edited' });

    expect(component.importedSpec()).toBeNull();
    expect(component.importPreview()).toBeNull();
    expect(component.editorNotice()).toContain('discarded');
  });

  it('a stale-plan refusal from start surfaces as an editor error', async () => {
    const component = fixture.componentInstance;
    await component.onImportPlanPreview();
    store.start.mockResolvedValue({
      success: false,
      error: { code: 'CAMPAIGN_PLAN_STALE', message: 'The plan docs/plans/big.md changed since this campaign was previewed.', timestamp: 1 },
    });

    await component.onRunCampaign();

    expect(component.editorError()).toContain('changed since this campaign was previewed');
  });
});
