import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_SERVICE } from '../../src/renderer/app/core/services/clipboard.service';
import { ElectronIpcService } from '../../src/renderer/app/core/services/ipc';
import { HistoryStore } from '../../src/renderer/app/core/state/history.store';
import { InstanceStore } from '../../src/renderer/app/core/state/instance.store';
import type { OutputMessage } from '../../src/renderer/app/core/state/instance/instance.types';
import { UsageStore } from '../../src/renderer/app/core/state/usage.store';
import { DisplayItemProcessor } from '../../src/renderer/app/features/instance-detail/display-item-processor.service';
import { ChildDiagnosticBundleModalService } from '../../src/renderer/app/features/orchestration/child-diagnostic-bundle.modal.service';
import { QuickActionDispatcherService } from '../../src/renderer/app/features/orchestration/quick-action-dispatcher.service';
import { SessionPickerController } from '../../src/renderer/app/features/sessions/session-picker.controller';
import { deriveVerdict } from '../../src/main/orchestration/verification-verdict-deriver';
import type { AgentResponse, VerificationResult } from '../../src/shared/types/verification.types';
import { VerificationVerdictReadyPayloadSchema } from '../../packages/contracts/src/schemas/verification.schemas';

const smokePaths = vi.hoisted(() => ({
  root: '',
  home: '',
  userData: '',
  lifecyclePath: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'home') return smokePaths.home;
      if (name === 'userData') return smokePaths.userData;
      return smokePaths.root;
    }),
    getVersion: vi.fn(() => '0.1.0-test'),
  },
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn(),
  },
  shell: {
    showItemInFolder: vi.fn(),
  },
  default: {
    app: {
      getPath: vi.fn((name: string) => {
        if (name === 'home') return smokePaths.home;
        if (name === 'userData') return smokePaths.userData;
        return smokePaths.root;
      }),
      getVersion: vi.fn(() => '0.1.0-test'),
    },
    ipcMain: {
      on: vi.fn(),
      handle: vi.fn(),
    },
    shell: {
      showItemInFolder: vi.fn(),
    },
  },
}));

vi.mock('../../src/main/logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../src/main/bootstrap/capability-probe', () => ({
  getCapabilityProbe: () => ({
    getLastReport: () => ({
      status: 'ready',
      generatedAt: Date.now(),
      checks: [],
    }),
    run: vi.fn(async () => ({
      status: 'ready',
      generatedAt: Date.now(),
      checks: [],
    })),
  }),
}));

vi.mock('../../src/main/browser-automation/browser-automation-health', () => ({
  getBrowserAutomationHealthService: () => ({
    diagnose: vi.fn(async () => ({
      status: 'ready',
      checkedAt: Date.now(),
      runtimeAvailable: true,
      nodeAvailable: true,
      inAppConfigured: true,
      inAppConnected: true,
      inAppToolCount: 1,
      warnings: [],
      suggestions: [],
      browserToolNames: ['browser'],
    })),
  }),
}));

vi.mock('../../src/main/providers/provider-doctor', () => ({
  getProviderDoctor: () => ({
    diagnose: vi.fn(async (provider: string) => ({
      overall: 'healthy',
      probes: [],
      recommendations: process.env['ANTHROPIC_API_KEY']
        ? [`Do not leak ${process.env['ANTHROPIC_API_KEY']} from ${provider}.`]
        : [],
      timestamp: Date.now(),
    })),
  }),
}));

vi.mock('../../src/main/commands/command-manager', () => ({
  getCommandManager: () => ({
    getAllCommandsSnapshot: async (workingDirectory?: string) => {
      if (!workingDirectory) {
        return { commands: [], diagnostics: [], scanDirs: [] };
      }
      const { getMarkdownCommandRegistry } = await import('../../src/main/commands/markdown-command-registry');
      return getMarkdownCommandRegistry().listCommands(workingDirectory);
    },
  }),
  CommandManager: class CommandManager {},
}));

vi.mock('../../src/main/cli/cli-detection', () => {
  const supported = ['claude', 'codex', 'gemini', 'copilot', 'cursor'] as const;
  const registry = Object.fromEntries(
    supported.map((cli) => [cli, { displayName: cli }]),
  );
  return {
    CLI_REGISTRY: registry,
    SUPPORTED_CLIS: supported,
    getCliDetectionService: () => ({
      detectAll: vi.fn(async () => ({ detected: [] })),
      scanAllCliInstalls: vi.fn(async () => []),
    }),
  };
});

vi.mock('../../src/main/cli/cli-update-service', () => ({
  getCliUpdateService: () => ({
    getUpdatePlan: vi.fn(async (cli: string) => ({
      cli,
      displayName: cli,
      supported: false,
      reason: 'not installed in smoke test',
    })),
  }),
}));

vi.mock('../../src/main/core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      broadRootFileThreshold: 100,
      commandDiagnosticsAvailable: true,
    }),
    get: (key: string) => key === 'broadRootFileThreshold' ? 100 : undefined,
  }),
}));

vi.mock('../../src/main/diagnostics/skill-diagnostics-service', () => ({
  getSkillDiagnosticsService: () => ({
    collect: vi.fn(async () => []),
  }),
}));

vi.mock('../../src/main/diagnostics/instruction-diagnostics-service', () => ({
  getInstructionDiagnosticsService: () => ({
    collect: vi.fn(async () => []),
  }),
}));

vi.mock('../../src/main/observability/lifecycle-trace', () => ({
  resolveLifecycleTraceFilePath: () => smokePaths.lifecyclePath,
}));

describe('Wave 7 cross-wave smoke', () => {
  beforeAll(async () => {
    smokePaths.root = await mkdtemp(join(tmpdir(), 'wave7-smoke-'));
    smokePaths.home = join(smokePaths.root, 'home');
    smokePaths.userData = join(smokePaths.root, 'userData');
    smokePaths.lifecyclePath = join(smokePaths.root, 'lifecycle.ndjson');
    await mkdir(smokePaths.home, { recursive: true });
    await mkdir(smokePaths.userData, { recursive: true });
    await writeFile(smokePaths.lifecyclePath, '');
  });

  afterAll(async () => {
    await rm(smokePaths.root, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('keeps usage-tracker and prompt-history stores in separate namespaces', async () => {
    const storageDir = await mkdtemp(join(smokePaths.root, 'stores-'));
    const { default: Store } = await import('electron-store');
    const usageStore = new Store({ name: 'usage-tracker', cwd: storageDir });
    const promptStore = new Store({ name: 'prompt-history', cwd: storageDir });

    usageStore.set('payload', { source: 'usage' });
    promptStore.set('payload', { source: 'prompt-history' });

    expect(usageStore.get('payload')).toEqual({ source: 'usage' });
    expect(promptStore.get('payload')).toEqual({ source: 'prompt-history' });

    const sameUsageStore = new Store({ name: 'usage-tracker', cwd: storageDir });
    expect(sameUsageStore.get('payload')).toEqual({ source: 'usage' });
  });

  it('routes the Wave 5 copy-prompt-hash quick action through the Wave 4 ClipboardService', async () => {
    const source = await readFile(
      join(process.cwd(), 'src/renderer/app/features/orchestration/quick-action-dispatcher.service.ts'),
      'utf-8',
    );
    expect(source).not.toContain('WAVE-4-MIGRATE');
    expect(source).not.toContain('navigator.clipboard.writeText');

    const fakeClipboard = { copyText: vi.fn(async () => ({ ok: true })) };
    TestBed.configureTestingModule({
      providers: [
        QuickActionDispatcherService,
        { provide: InstanceStore, useValue: { setSelectedInstance: vi.fn() } },
        { provide: ElectronIpcService, useValue: { invoke: vi.fn() } },
        { provide: ChildDiagnosticBundleModalService, useValue: { open: vi.fn() } },
        { provide: CLIPBOARD_SERVICE, useValue: fakeClipboard },
      ],
    });

    const service = TestBed.inject(QuickActionDispatcherService);
    await expect(service.dispatch({
      kind: 'copy-prompt-hash',
      childInstanceId: 'child-1',
      spawnPromptHash: 'hash-123',
    })).resolves.toEqual({ ok: true });
    expect(fakeClipboard.copyText).toHaveBeenCalledWith('hash-123', { label: 'prompt hash' });
  });

  it('flows markdown command diagnostics through the Doctor command section', async () => {
    const workingDirectory = await mkdtemp(join(smokePaths.root, 'project-'));
    const commandDir = join(workingDirectory, '.orchestrator', 'commands');
    await mkdir(commandDir, { recursive: true });
    await writeFile(
      join(commandDir, 'one.md'),
      ['---', 'aliases: ["same"]', '---', '# One', 'Body'].join('\n'),
    );
    await writeFile(
      join(commandDir, 'two.md'),
      ['---', 'aliases: ["same"]', '---', '# Two', 'Body'].join('\n'),
    );

    const { _resetMarkdownCommandRegistryForTesting } = await import('../../src/main/commands/markdown-command-registry');
    _resetMarkdownCommandRegistryForTesting();
    const { getCommandManager } = await import('../../src/main/commands/command-manager');
    const snapshot = await getCommandManager().getAllCommandsSnapshot(workingDirectory);
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'alias-collision' }));

    const { DoctorService } = await import('../../src/main/diagnostics/doctor-service');
    const report = await new DoctorService().getReport({ workingDirectory, force: true });
    expect(report.commandDiagnostics.available).toBe(true);
    expect(report.commandDiagnostics.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'alias-collision' }),
    );
  });

  it('uses UsageStore frecency when ranking Wave 2 session picker results', () => {
    const instances = signal([
      {
        id: 'inst-a',
        displayName: 'Older low-use session',
        sessionId: 'session-a',
        provider: 'claude',
        currentModel: 'sonnet',
        workingDirectory: '/repo',
        lastActivity: 2,
      },
      {
        id: 'inst-b',
        displayName: 'Recent high-use session',
        sessionId: 'session-b',
        provider: 'codex',
        currentModel: 'gpt',
        workingDirectory: '/repo',
        lastActivity: 1,
      },
    ]);
    const fakeUsageStore = {
      frecency: vi.fn((_kind: string, id: string) => id === 'inst-b' ? 20 : 0),
      record: vi.fn(async () => undefined),
    };

    TestBed.configureTestingModule({
      providers: [
        SessionPickerController,
        { provide: InstanceStore, useValue: { instances, setSelectedInstance: vi.fn() } },
        { provide: HistoryStore, useValue: { entries: signal([]), restoreEntry: vi.fn() } },
        { provide: UsageStore, useValue: fakeUsageStore },
      ],
    });

    const controller = TestBed.inject(SessionPickerController);
    expect(controller.groups()[0].items.map((item) => item.value.id)).toEqual(['inst-b', 'inst-a']);
  });

  it('keeps compaction summaries out of system-event grouping and suppresses interrupt boundaries', () => {
    const processor = new DisplayItemProcessor();
    const messages: OutputMessage[] = [
      {
        id: 'sys-1',
        type: 'system',
        content: 'polling children',
        timestamp: 100,
        metadata: { source: 'orchestration', action: 'get_children' },
      },
      {
        id: 'sys-2',
        type: 'system',
        content: 'polling children again',
        timestamp: 110,
        metadata: { source: 'orchestration', action: 'get_children' },
      },
      {
        id: 'compact-1',
        type: 'system',
        content: 'compacted',
        timestamp: 120,
        metadata: {
          kind: 'compaction-summary',
          reason: 'context-budget',
          beforeCount: 80,
          afterCount: 30,
          at: 120,
        },
      },
      {
        id: 'interrupt-1',
        type: 'system',
        content: 'interrupt completed',
        timestamp: 130,
        metadata: {
          kind: 'interrupt-boundary',
          phase: 'completed',
          requestId: 'req-1',
          outcome: 'respawn-success',
          at: 130,
        },
      },
    ];

    const items = processor.process(messages);

    expect(items.map((item) => item.type)).toEqual([
      'system-event-group',
      'compaction-summary',
    ]);
    const groupedIds = items
      .filter((item) => item.type === 'system-event-group')
      .flatMap((item) => item.systemEvents?.map((message) => message.id) ?? []);
    expect(groupedIds).toEqual(['sys-1', 'sys-2']);
    expect(groupedIds).not.toContain('compact-1');
    expect(groupedIds).not.toContain('interrupt-1');
  });

  it('preserves raw verification responses through verdict derivation and IPC schema parsing', () => {
    const longText = 'response '.repeat(500);
    const responses: AgentResponse[] = [0, 1, 2].map((index) => ({
      agentId: `agent-${index}`,
      agentIndex: index,
      model: `model-${index}`,
      response: `${longText}${index}`,
      keyPoints: [],
      confidence: 0.9,
      duration: 100 + index,
      tokens: 200 + index,
      cost: 0.01,
    }));
    const result: VerificationResult = {
      id: 'result-1',
      request: {
        id: 'request-1',
        instanceId: 'instance-1',
        prompt: 'Verify this',
        config: {
          agentCount: 3,
          timeout: 1000,
          synthesisStrategy: 'debate',
        },
      },
      responses,
      analysis: {
        agreements: [],
        disagreements: [],
        uniqueInsights: [],
        responseRankings: [],
        outlierAgents: [],
        overallConfidence: 0.9,
        consensusStrength: 1,
      },
      synthesizedResponse: 'ok',
      synthesisMethod: 'debate',
      synthesisConfidence: 0.9,
      totalDuration: 300,
      totalTokens: 600,
      totalCost: 0.03,
      completedAt: 123,
    };

    const { verdict } = deriveVerdict(result, { now: 456 });
    expect(verdict.rawResponses).toEqual(responses);

    const parsed = VerificationVerdictReadyPayloadSchema.parse({
      resultId: result.id,
      instanceId: result.request.instanceId,
      verdict,
    });
    expect(parsed.verdict.rawResponses).toEqual(responses);
  });

  it('keeps exported operator artifact bundles redacted and home-relative', async () => {
    const secret = 'sk-test-shouldnotleak1234567890';
    const previousSecret = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = secret;
    const homeRepo = join(homedir(), 'wave7-smoke-repo');
    await writeFile(
      smokePaths.lifecyclePath,
      JSON.stringify({
        path: join(homeRepo, 'file.ts'),
        token: secret,
        envRef: 'process.env.ANTHROPIC_API_KEY',
      }),
    );

    try {
      const { OperatorArtifactExporter } = await import('../../src/main/diagnostics/operator-artifact-exporter');
      const exporter = new OperatorArtifactExporter();
      const result = await exporter.export({
        workingDirectory: homeRepo,
        force: true,
      });
      const zipText = (await readFile(result.bundlePath)).toString('utf-8');

      expect(result.manifest.workingDirectory).toMatch(/^~\//);
      expect(result.manifest.redactionPolicy.environmentVariables).toBe('presence-only');
      expect(result.manifest.redactionPolicy.homePaths).toBe('home-relative');
      expect(zipText).not.toContain(secret);
      expect(zipText).not.toContain(homedir());
      expect(zipText).toContain('<redacted-secret>');
      expect(zipText).toContain('~');
    } finally {
      if (previousSecret === undefined) {
        delete process.env['ANTHROPIC_API_KEY'];
      } else {
        process.env['ANTHROPIC_API_KEY'] = previousSecret;
      }
    }
  });
});
