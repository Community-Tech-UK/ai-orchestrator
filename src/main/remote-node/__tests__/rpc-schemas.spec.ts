import { describe, it, expect } from 'vitest';
import {
  NodeRegisterParamsSchema,
  NodeHeartbeatParamsSchema,
  InstanceSpawnParamsSchema,
  TerminalCreateParamsSchema,
  TerminalInputParamsSchema,
  TerminalResizeParamsSchema,
  TerminalKillParamsSchema,
  TerminalOutputParamsSchema,
  TerminalExitParamsSchema,
  ProviderDiagnoseParamsSchema,
  AudioTranscribeParamsSchema,
  AuxiliaryModelListParamsSchema,
  AuxiliaryModelGenerateParamsSchema,
  ConfigUpdateParamsSchema,
  FsReadFileParamsSchema,
  FsWriteFileParamsSchema,
  LocalModelSessionIdParamsSchema,
  LocalModelSessionSendInputParamsSchema,
  LocalModelSessionStartParamsSchema,
  LocalAiHealthCheckParamsSchema,
  LocalAiHealthCheckResultSchema,
  LocalAiHealthDiagnoseParamsSchema,
  LocalAiHealthDiagnoseResultSchema,
  LocalAiHealthRepairParamsSchema,
  LocalAiHealthRepairResultSchema,
  BrowserExtAttachTabParamsSchema,
  BrowserExtPollCommandParamsSchema,
  BrowserExtCommandResultParamsSchema,
  RPC_PARAM_SCHEMAS,
  COORDINATOR_TO_NODE_PARAM_SCHEMAS,
  validateRpcParams,
} from '../rpc-schemas';
import {
  BoundedServiceRpcResponseError,
  parseBoundedServiceRpcResponse,
} from '../worker-node-connection-helpers';
import { LOCAL_AI_TARGET_NUMERIC_LIMITS } from '../../../shared/types/local-ai-guard.types';
import { LocalAiTargetConfigSchema } from '../../../shared/validation/local-ai-guard.schemas';

describe('rpc-schemas', () => {
  const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
  const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

  describe('NodeRegisterParamsSchema', () => {
    it('accepts valid registration', () => {
      const result = NodeRegisterParamsSchema.safeParse({
        nodeId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'windows-pc',
        capabilities: {
          platform: 'win32',
          arch: 'x64',
          cpuCores: 16,
          totalMemoryMB: 96000,
          availableMemoryMB: 64000,
          supportedClis: ['claude'],
          hasBrowserRuntime: true,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 10,
          workingDirectories: ['/tmp'],
        },
        token: 'secret-token',
        address: '100.106.40.97',
      });
      expect(result.success).toBe(true);
    });

    it('accepts Android automation capability summaries', () => {
      const result = NodeRegisterParamsSchema.safeParse({
        nodeId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'windows-android',
        capabilities: {
          platform: 'win32',
          arch: 'x64',
          cpuCores: 16,
          totalMemoryMB: 96000,
          availableMemoryMB: 64000,
          supportedClis: ['claude'],
          hasBrowserRuntime: true,
          hasBrowserMcp: false,
          hasAndroidMcp: true,
          androidAutomation: {
            enabled: true,
            sdkPath: 'C:\\Android\\Sdk',
            adbVersion: 'Android Debug Bridge version 1.0.41',
            avds: ['Pixel_8'],
            connectedDevices: [
              { serial: 'emulator-5554', kind: 'emulator', state: 'device', apiLevel: 35 },
              { serial: 'ABC123', kind: 'usb', state: 'unauthorized' },
            ],
            emulatorRunning: true,
            hasMaestro: true,
          },
          hasDocker: false,
          maxConcurrentInstances: 10,
          workingDirectories: ['/tmp'],
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts worker-local STT endpoint capabilities', () => {
      const result = NodeRegisterParamsSchema.safeParse({
        nodeId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'windows-stt',
        capabilities: {
          platform: 'win32',
          arch: 'x64',
          cpuCores: 16,
          totalMemoryMB: 96000,
          availableMemoryMB: 64000,
          supportedClis: ['claude'],
          hasBrowserRuntime: true,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 10,
          workingDirectories: ['/tmp'],
          localSttEndpoints: [
            {
              provider: 'openai-compatible',
              baseUrl: 'http://127.0.0.1:8000',
              models: ['distil-large-v3'],
              healthy: true,
            },
          ],
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts file transfer capability summaries', () => {
      const result = NodeRegisterParamsSchema.safeParse({
        nodeId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'windows-files',
        capabilities: {
          platform: 'win32',
          arch: 'x64',
          cpuCores: 16,
          totalMemoryMB: 96000,
          availableMemoryMB: 64000,
          supportedClis: ['claude'],
          hasBrowserRuntime: true,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 10,
          workingDirectories: ['C:\\work'],
          fileTransfer: {
            enabled: true,
            maxFileBytes: 1024,
            roots: [
              {
                id: 'downloads',
                label: 'Downloads',
                path: 'C:\\Users\\James\\Downloads',
                read: true,
                write: false,
              },
            ],
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it('preserves non-secret worker and extension rollout evidence', () => {
      const result = NodeHeartbeatParamsSchema.parse({
        nodeId: 'node-1',
        capabilities: {
          workerAgent: {
            version: '0.1.0',
            startedAt: 1_700_000_000_000,
          },
          platform: 'win32',
          arch: 'x64',
          cpuCores: 16,
          totalMemoryMB: 96000,
          availableMemoryMB: 64000,
          supportedClis: ['claude'],
          hasBrowserRuntime: true,
          hasBrowserMcp: false,
          hasExtensionRelay: true,
          extensionRelay: {
            enabled: true,
            running: true,
            extensionVersion: '0.2.1',
            extensionReloadedAt: 1_700_000_010_000,
            lastExtensionContactAt: 1_700_000_020_000,
          },
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 10,
          workingDirectories: ['/tmp'],
        },
        activeInstances: 0,
      });

      expect(result.capabilities.workerAgent).toEqual({
        version: '0.1.0',
        startedAt: 1_700_000_000_000,
      });
      expect(result.capabilities.extensionRelay).toMatchObject({
        extensionVersion: '0.2.1',
        extensionReloadedAt: 1_700_000_010_000,
        lastExtensionContactAt: 1_700_000_020_000,
      });
    });

    it('accepts the standard reporter local-model endpoint payload', () => {
      const result = NodeHeartbeatParamsSchema.safeParse({
        nodeId: 'node-1',
        capabilities: {
          platform: 'win32',
          arch: 'x64',
          cpuCores: 16,
          totalMemoryMB: 96000,
          availableMemoryMB: 64000,
          supportedClis: ['claude'],
          hasBrowserRuntime: true,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 10,
          workingDirectories: ['/tmp'],
          localModelEndpoints: [
            {
              provider: 'ollama',
              endpointId: 'ollama',
              baseUrl: 'http://127.0.0.1:11434',
              models: ['qwen3:14b'],
              healthy: true,
            },
            {
              provider: 'openai-compatible',
              endpointId: 'openai-compatible',
              baseUrl: 'http://127.0.0.1:1234',
              models: ['gemma-3-12b'],
              healthy: true,
            },
          ],
        },
        activeInstances: 0,
      });

      expect(result.success).toBe(true);
    });

    it('enforces the shared Local AI context boundaries for loaded-model capacity', () => {
      const heartbeat = (contextLength: number) => ({
        nodeId: 'node-1',
        capabilities: {
          platform: 'linux',
          arch: 'x64',
          cpuCores: 8,
          totalMemoryMB: 32_000,
          availableMemoryMB: 16_000,
          supportedClis: [],
          hasBrowserRuntime: false,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 2,
          workingDirectories: ['/workspace'],
          localModelEndpoints: [{
            provider: 'openai-compatible',
            endpointId: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1234',
            models: ['large-context-model'],
            loadedModels: [{ id: 'large-context-model', contextLength }],
            healthy: true,
          }],
        },
        activeInstances: 0,
      });

      const { min, max } = LOCAL_AI_TARGET_NUMERIC_LIMITS.minContextLength;
      const cases = [
        { contextLength: 0, accepted: false },
        { contextLength: min, accepted: true },
        { contextLength: max, accepted: true },
        { contextLength: max + 1, accepted: false },
        { contextLength: Number.NaN, accepted: false },
        { contextLength: min + 0.5, accepted: false },
        { contextLength: Number.MAX_SAFE_INTEGER, accepted: false },
      ];

      for (const { contextLength, accepted } of cases) {
        expect(
          NodeHeartbeatParamsSchema.safeParse(heartbeat(contextLength)).success,
          `contextLength=${String(contextLength)}`,
        ).toBe(accepted);
      }
    });

    it('rejects heartbeats with more than 1,000 local-model endpoint descriptors', () => {
      const result = NodeHeartbeatParamsSchema.safeParse({
        nodeId: 'node-1',
        capabilities: {
          platform: 'win32',
          arch: 'x64',
          cpuCores: 16,
          totalMemoryMB: 96000,
          availableMemoryMB: 64000,
          supportedClis: ['claude'],
          hasBrowserRuntime: true,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 10,
          workingDirectories: ['/tmp'],
          localModelEndpoints: Array.from({ length: 1_001 }, (_, index) => ({
            provider: 'ollama',
            endpointId: `ollama-${index}`,
            baseUrl: `http://127.0.0.1:${20_000 + index}`,
            models: [],
            healthy: true,
          })),
        },
        activeInstances: 0,
      });

      expect(result.success).toBe(false);
    });

    it('accepts non-secret file transfer capability summaries', () => {
      const result = NodeRegisterParamsSchema.safeParse({
        nodeId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        name: 'windows-files',
        capabilities: {
          platform: 'win32',
          arch: 'x64',
          cpuCores: 16,
          totalMemoryMB: 96000,
          availableMemoryMB: 64000,
          supportedClis: ['claude'],
          hasBrowserRuntime: true,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 10,
          workingDirectories: ['C:\\work'],
          fileTransfer: {
            enabled: true,
            maxFileBytes: 50 * 1024 * 1024,
            roots: [
              {
                id: 'downloads',
                label: 'Downloads',
                path: 'C:\\Users\\James\\Downloads',
                read: true,
                write: false,
              },
            ],
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing nodeId', () => {
      const result = NodeRegisterParamsSchema.safeParse({ name: 'test' });
      expect(result.success).toBe(false);
    });
  });

  describe('InstanceSpawnParamsSchema', () => {
    it('accepts Android placement preferences', () => {
      const result = InstanceSpawnParamsSchema.safeParse({
        instanceId: 'inst-1',
        cliType: 'claude',
        workingDirectory: '/workspace',
        nodePlacement: {
          requiresAndroid: true,
          androidDeviceKind: 'physical',
          requiresBrowser: true,
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid Android device kind', () => {
      const result = InstanceSpawnParamsSchema.safeParse({
        instanceId: 'inst-1',
        cliType: 'claude',
        workingDirectory: '/workspace',
        nodePlacement: {
          requiresAndroid: true,
          androidDeviceKind: 'tablet',
        },
      });
      expect(result.success).toBe(false);
    });

    it('accepts model ids up to the dynamic catalog limit', () => {
      expect(maxCatalogModelId).toHaveLength(512);

      expect(InstanceSpawnParamsSchema.safeParse({
        instanceId: 'inst-1',
        cliType: 'claude',
        workingDirectory: '/workspace',
        model: maxCatalogModelId,
      }).success).toBe(true);
    });

    it('rejects model ids beyond the dynamic catalog limit', () => {
      expect(tooLongCatalogModelId).toHaveLength(513);

      expect(InstanceSpawnParamsSchema.safeParse({
        instanceId: 'inst-1',
        cliType: 'claude',
        workingDirectory: '/workspace',
        model: tooLongCatalogModelId,
      }).success).toBe(false);
    });
  });

  describe('terminal schemas', () => {
    it('accepts a valid terminal.create with optional fields', () => {
      const r = TerminalCreateParamsSchema.safeParse({
        sessionId: 'term-1',
        cwd: '/home/user/project',
        shell: '/bin/zsh',
        env: { PATH: '/usr/bin', TERM: 'xterm-256color' },
        cols: 120,
        rows: 40,
      });
      expect(r.success).toBe(true);
    });

    it('accepts a minimal terminal.create (just sessionId + cwd)', () => {
      expect(TerminalCreateParamsSchema.safeParse({ sessionId: 't', cwd: '/x' }).success).toBe(true);
    });

    it('rejects terminal.create without a cwd', () => {
      expect(TerminalCreateParamsSchema.safeParse({ sessionId: 't' }).success).toBe(false);
    });

    it('rejects non-string env values', () => {
      expect(
        TerminalCreateParamsSchema.safeParse({ sessionId: 't', cwd: '/x', env: { N: 5 } }).success,
      ).toBe(false);
    });

    it('rejects absurd PTY dimensions', () => {
      expect(TerminalResizeParamsSchema.safeParse({ sessionId: 't', cols: 999999, rows: 40 }).success).toBe(false);
      expect(TerminalResizeParamsSchema.safeParse({ sessionId: 't', cols: 0, rows: 40 }).success).toBe(false);
    });

    it('accepts terminal.input / resize / kill', () => {
      expect(TerminalInputParamsSchema.safeParse({ sessionId: 't', data: 'ls -la\n' }).success).toBe(true);
      expect(TerminalResizeParamsSchema.safeParse({ sessionId: 't', cols: 80, rows: 24 }).success).toBe(true);
      expect(TerminalKillParamsSchema.safeParse({ sessionId: 't' }).success).toBe(true);
      expect(TerminalKillParamsSchema.safeParse({ sessionId: 't', signal: 'SIGTERM' }).success).toBe(true);
    });

    it('accepts terminal.output / exit notifications', () => {
      expect(TerminalOutputParamsSchema.safeParse({ sessionId: 't', data: 'hi', seq: 3 }).success).toBe(true);
      expect(TerminalExitParamsSchema.safeParse({ sessionId: 't', exitCode: 0, signal: null }).success).toBe(true);
      expect(TerminalExitParamsSchema.safeParse({ sessionId: 't', exitCode: null }).success).toBe(true);
    });

    it('registers terminal methods in the coordinator->node schema map', () => {
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['terminal.create']).toBe(TerminalCreateParamsSchema);
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['terminal.input']).toBe(TerminalInputParamsSchema);
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['terminal.resize']).toBe(TerminalResizeParamsSchema);
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['terminal.kill']).toBe(TerminalKillParamsSchema);
    });
  });

  describe('provider diagnostics schema', () => {
    it('accepts supported remote provider diagnostics requests', () => {
      expect(ProviderDiagnoseParamsSchema.safeParse({ provider: 'copilot' }).success).toBe(true);
      expect(ProviderDiagnoseParamsSchema.safeParse({ provider: 'cursor' }).success).toBe(true);
    });

    it('rejects auto because diagnostics need a concrete provider runtime', () => {
      expect(ProviderDiagnoseParamsSchema.safeParse({ provider: 'auto' }).success).toBe(false);
    });

    it('registers provider.diagnose in the coordinator->node schema map', () => {
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['provider.diagnose']).toBe(ProviderDiagnoseParamsSchema);
    });
  });

  describe('file transfer schemas', () => {
    it('accepts fs.readFile and fs.writeFile coordinator payloads', () => {
      expect(FsReadFileParamsSchema.safeParse({ path: '/tmp/file.pdf' }).success).toBe(true);
      expect(FsWriteFileParamsSchema.safeParse({
        path: '/tmp/file.pdf',
        data: Buffer.from('bytes').toString('base64'),
        mkdirp: true,
      }).success).toBe(true);
    });

    it('registers fs.readFile and fs.writeFile in the coordinator->node schema map', () => {
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['fs.readFile']).toBe(FsReadFileParamsSchema);
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['fs.writeFile']).toBe(FsWriteFileParamsSchema);
    });

    it('accepts fileTransfer in service config.update payloads', () => {
      expect(ConfigUpdateParamsSchema.safeParse({
        fileTransfer: {
          enabled: true,
          maxFileBytes: 1024,
          roots: [
            {
              id: 'scratch',
              label: 'AIO Scratch',
              path: '/home/user/.orchestrator/_scratch/aio-transfers',
              read: true,
              write: true,
            },
          ],
        },
      }).success).toBe(true);
    });
  });

  describe('AudioTranscribeParamsSchema', () => {
    const validOpenAiCompatible = {
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8000',
      model: 'distil-large-v3',
      language: 'en',
      task: 'transcribe',
      audioBase64: 'UklGRg==',
      sampleRate: 16000,
      timeoutMs: 30000,
    };

    it('accepts an OpenAI-compatible local STT request', () => {
      expect(AudioTranscribeParamsSchema.safeParse(validOpenAiCompatible).success).toBe(true);
    });

    it('accepts a whisper-cli request without a base URL', () => {
      expect(AudioTranscribeParamsSchema.safeParse({
        provider: 'whisper-cli',
        model: 'distil-large-v3',
        language: 'en',
        task: 'transcribe',
        audioBase64: 'UklGRg==',
        sampleRate: 16000,
        timeoutMs: 30000,
      }).success).toBe(true);
    });

    it('rejects empty audio and unsupported tasks', () => {
      expect(AudioTranscribeParamsSchema.safeParse({
        ...validOpenAiCompatible,
        audioBase64: '',
      }).success).toBe(false);
      expect(AudioTranscribeParamsSchema.safeParse({
        ...validOpenAiCompatible,
        task: 'summarize',
      }).success).toBe(false);
    });

    it('registers audio.transcribe in the coordinator->node schema map', () => {
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['audio.transcribe']).toBe(AudioTranscribeParamsSchema);
    });
  });

  describe('remote browser extension relay schemas', () => {
    it('registers node-to-coordinator browser extension relay methods', () => {
      expect(RPC_PARAM_SCHEMAS['browser.ext.attachTab']).toBe(BrowserExtAttachTabParamsSchema);
      expect(RPC_PARAM_SCHEMAS['browser.ext.pollCommand']).toBe(BrowserExtPollCommandParamsSchema);
      expect(RPC_PARAM_SCHEMAS['browser.ext.commandResult']).toBe(BrowserExtCommandResultParamsSchema);
    });

    it('accepts bounded attach-tab payloads and rejects oversized poll waits', () => {
      expect(BrowserExtAttachTabParamsSchema.safeParse({
        token: 'session-token',
        extensionOrigin: 'chrome-extension://id/',
        payload: {
          tabId: 42,
          windowId: 7,
          url: 'https://play.google.com/console',
          title: 'Play Console',
          text: 'dashboard',
        },
      }).success).toBe(true);

      expect(BrowserExtPollCommandParamsSchema.safeParse({
        token: 'session-token',
        timeoutMs: 10_001,
      }).success).toBe(false);
    });
  });

  describe('AuxiliaryModelListParamsSchema', () => {
    it('accepts ollama as provider', () => {
      expect(AuxiliaryModelListParamsSchema.safeParse({ provider: 'ollama' }).success).toBe(true);
    });

    it('accepts openai-compatible as provider', () => {
      expect(AuxiliaryModelListParamsSchema.safeParse({ provider: 'openai-compatible' }).success).toBe(true);
    });

    it('rejects missing provider', () => {
      expect(AuxiliaryModelListParamsSchema.safeParse({}).success).toBe(false);
    });

    it('rejects unknown provider value', () => {
      expect(AuxiliaryModelListParamsSchema.safeParse({ provider: 'anthropic' }).success).toBe(false);
    });

    it('registers auxiliaryModel.list in the coordinator->node schema map', () => {
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['auxiliaryModel.list']).toBe(AuxiliaryModelListParamsSchema);
    });
  });

  describe('AuxiliaryModelGenerateParamsSchema', () => {
    const validGenerate = {
      provider: 'ollama',
      model: 'llama3.2:3b',
      systemPrompt: 'You are a helpful assistant.',
      userPrompt: 'Summarize this text.',
      temperature: 0.7,
      maxOutputTokens: 512,
      timeoutMs: 30000,
      requireJson: false,
    };

    it('accepts a valid generate request', () => {
      expect(AuxiliaryModelGenerateParamsSchema.safeParse(validGenerate).success).toBe(true);
    });

    it('rejects empty model string', () => {
      expect(
        AuxiliaryModelGenerateParamsSchema.safeParse({ ...validGenerate, model: '' }).success
      ).toBe(false);
    });

    it('rejects negative timeout', () => {
      expect(
        AuxiliaryModelGenerateParamsSchema.safeParse({ ...validGenerate, timeoutMs: -1 }).success
      ).toBe(false);
    });

    it('rejects zero timeout', () => {
      expect(
        AuxiliaryModelGenerateParamsSchema.safeParse({ ...validGenerate, timeoutMs: 0 }).success
      ).toBe(false);
    });

    it('rejects negative maxOutputTokens', () => {
      expect(
        AuxiliaryModelGenerateParamsSchema.safeParse({ ...validGenerate, maxOutputTokens: -100 }).success
      ).toBe(false);
    });

    it('rejects temperature above 2', () => {
      expect(
        AuxiliaryModelGenerateParamsSchema.safeParse({ ...validGenerate, temperature: 2.5 }).success
      ).toBe(false);
    });

    it('rejects temperature below 0', () => {
      expect(
        AuxiliaryModelGenerateParamsSchema.safeParse({ ...validGenerate, temperature: -0.1 }).success
      ).toBe(false);
    });

    it('rejects missing provider', () => {
      const { provider: _, ...withoutProvider } = validGenerate;
      expect(AuxiliaryModelGenerateParamsSchema.safeParse(withoutProvider).success).toBe(false);
    });

    it('registers auxiliaryModel.generate in the coordinator->node schema map', () => {
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['auxiliaryModel.generate']).toBe(AuxiliaryModelGenerateParamsSchema);
    });
  });

  describe('local model session schemas', () => {
    const validStart = {
      sessionId: 'local-model-session-1',
      endpointProvider: 'openai-compatible',
      endpointId: 'openai-compatible',
      modelId: 'qwen2.5-coder-14b',
      workingDirectory: '/workspace',
      systemPrompt: 'You are concise.',
    };

    it('accepts bounded local model session start payloads', () => {
      expect(LocalModelSessionStartParamsSchema.safeParse(validStart).success).toBe(true);
      expect(LocalModelSessionStartParamsSchema.safeParse({
        ...validStart,
        endpointProvider: 'claude',
      }).success).toBe(false);
    });

    it('accepts local model send-input payloads with attachments', () => {
      expect(LocalModelSessionSendInputParamsSchema.safeParse({
        sessionId: 'local-model-session-1',
        message: 'Summarize this file',
        attachments: [{ name: 'notes.txt', type: 'text/plain', size: 5, data: 'hello' }],
      }).success).toBe(true);
    });

    it('accepts local model session id payloads', () => {
      expect(LocalModelSessionIdParamsSchema.safeParse({ sessionId: 'local-model-session-1' }).success)
        .toBe(true);
      expect(LocalModelSessionIdParamsSchema.safeParse({ sessionId: '' }).success).toBe(false);
    });

    it('registers local model session methods in coordinator->node schema map', () => {
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['localModel.session.start'])
        .toBe(LocalModelSessionStartParamsSchema);
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['localModel.session.sendInput'])
        .toBe(LocalModelSessionSendInputParamsSchema);
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['localModel.session.terminate'])
        .toBe(LocalModelSessionIdParamsSchema);
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['localModel.session.interrupt'])
        .toBe(LocalModelSessionIdParamsSchema);
    });
  });

  describe('Local AI health RPC schemas', () => {
    const validCheck = {
      provider: 'ollama',
      endpointId: 'ollama',
      expectedModels: [
        { modelId: 'qwen3:8b', required: true, minContextLength: 8_192 },
      ],
      kind: 'functional',
      canary: {
        contract: 'exact-token-v1',
        model: 'qwen3:8b',
      },
      latencyThresholdMs: 2_000,
      timeoutMs: 30_000,
    };
    const canonicalRepairOutcomes = [
      { outcome: 'guided', supported: true, attempted: false, recovered: false },
      { outcome: 'unsupported', supported: false, attempted: false, recovered: false },
      { outcome: 'not-attempted', supported: true, attempted: false, recovered: false },
      { outcome: 'execution-failed', supported: true, attempted: true, recovered: false },
      { outcome: 'completed-not-recovered', supported: true, attempted: true, recovered: false },
      { outcome: 'recovered', supported: true, attempted: true, recovered: true },
    ] as const;
    const repairBase = {
      targetId: 'ollama',
      action: 'restart-ollama',
      message: 'Safe worker result.',
      completedAt: 1_700_000_000_000,
    };

    it('accepts a bounded named-canary request and registers all three service methods', () => {
      const { kind: _kind, ...diagnose } = validCheck;
      expect(LocalAiHealthCheckParamsSchema.parse(validCheck)).toEqual(validCheck);
      expect(LocalAiHealthDiagnoseParamsSchema.safeParse(diagnose).success).toBe(true);
      expect(LocalAiHealthRepairParamsSchema.safeParse({
        provider: 'ollama',
        endpointId: 'ollama',
        action: 'restart-ollama',
      }).success).toBe(true);
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['localAi.health.check'])
        .toBe(LocalAiHealthCheckParamsSchema);
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['localAi.health.diagnose'])
        .toBe(LocalAiHealthDiagnoseParamsSchema);
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['localAi.health.repair'])
        .toBe(LocalAiHealthRepairParamsSchema);
    });

    it('enforces the same expected-model context boundaries as the trusted target contract', () => {
      const targetConfig = {
        lifecycle: 'enrolled',
        location: { type: 'worker', nodeId: 'node-1' },
        provider: 'ollama',
        endpointId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        expectedModels: [{ modelId: 'qwen3:8b', required: true }],
        canary: { model: 'qwen3:8b', timeoutMs: 30_000, intervalMs: 600_000 },
        endpointCheckIntervalMs: 60_000,
        freshnessLimitMs: 120_000,
        warningLatencyMs: 2_000,
        routingRoles: ['compression'],
        fallbackPolicy: 'notify-and-allow',
        slotFallbackPolicies: {},
        recovery: { automatic: false, maxAttempts: 2, cooldownMs: 60_000 },
      };

      for (const minContextLength of [1, 100_000_000]) {
        expect(LocalAiTargetConfigSchema.safeParse({
          ...targetConfig,
          expectedModels: [{ modelId: 'qwen3:8b', required: true, minContextLength }],
        }).success).toBe(true);
        expect(LocalAiHealthCheckParamsSchema.safeParse({
          ...validCheck,
          expectedModels: [{ modelId: 'qwen3:8b', required: true, minContextLength }],
        }).success).toBe(true);
      }

      for (const minContextLength of [0, 100_000_001]) {
        expect(LocalAiTargetConfigSchema.safeParse({
          ...targetConfig,
          expectedModels: [{ modelId: 'qwen3:8b', required: true, minContextLength }],
        }).success).toBe(false);
        expect(LocalAiHealthCheckParamsSchema.safeParse({
          ...validCheck,
          expectedModels: [{ modelId: 'qwen3:8b', required: true, minContextLength }],
        }).success).toBe(false);
      }
    });

    it('enforces the same expected-model relationships as the trusted target contract', () => {
      const trustedConfig = {
        lifecycle: 'enrolled',
        location: { type: 'worker', nodeId: 'node-1' },
        provider: 'ollama',
        endpointId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        expectedModels: [
          { modelId: 'qwen3:8b', required: true },
          { modelId: 'qwen3:14b', required: false },
        ],
        canary: { model: 'qwen3:8b', timeoutMs: 30_000, intervalMs: 600_000 },
        endpointCheckIntervalMs: 60_000,
        freshnessLimitMs: 120_000,
        warningLatencyMs: 2_000,
        routingRoles: ['compression'],
        fallbackPolicy: 'notify-and-allow',
        slotFallbackPolicies: {},
        recovery: { automatic: false, maxAttempts: 2, cooldownMs: 60_000 },
      };
      const workerCheck = {
        ...validCheck,
        expectedModels: trustedConfig.expectedModels,
        canary: {
          contract: 'exact-token-v1',
          model: trustedConfig.canary.model,
        },
      };

      expect(LocalAiTargetConfigSchema.safeParse(trustedConfig).success).toBe(true);
      expect(LocalAiHealthCheckParamsSchema.safeParse(workerCheck).success).toBe(true);
      expect(LocalAiTargetConfigSchema.parse(trustedConfig).expectedModels)
        .toEqual(trustedConfig.expectedModels);

      const invalidRelationships = [
        {
          expectedModels: [
            trustedConfig.expectedModels[0],
            { ...trustedConfig.expectedModels[0], required: false },
          ],
          canaryModel: trustedConfig.canary.model,
        },
        {
          expectedModels: trustedConfig.expectedModels,
          canaryModel: 'not-expected',
        },
      ];

      for (const invalid of invalidRelationships) {
        expect(LocalAiTargetConfigSchema.safeParse({
          ...trustedConfig,
          expectedModels: invalid.expectedModels,
          canary: { ...trustedConfig.canary, model: invalid.canaryModel },
        }).success).toBe(false);
        expect(LocalAiHealthCheckParamsSchema.safeParse({
          ...workerCheck,
          expectedModels: invalid.expectedModels,
          canary: { ...workerCheck.canary, model: invalid.canaryModel },
        }).success).toBe(false);
      }
    });

    it('rejects caller prompts, commands, URLs, executable arguments, and unknown keys', () => {
      for (const forbidden of [
        { prompt: 'include repository content' },
        { command: 'sh' },
        { baseUrl: 'http://attacker.invalid' },
        { executable: '/bin/sh' },
        { args: ['-c', 'arbitrary'] },
      ]) {
        expect(LocalAiHealthCheckParamsSchema.safeParse({
          ...validCheck,
          ...forbidden,
        }).success).toBe(false);
      }
    });

    it('rejects an unbounded request and a canary model outside the expected-model allow-list', () => {
      expect(LocalAiHealthCheckParamsSchema.safeParse({
        ...validCheck,
        timeoutMs: 120_001,
      }).success).toBe(false);
      expect(LocalAiHealthCheckParamsSchema.safeParse({
        ...validCheck,
        expectedModels: [{ modelId: 'qwen3:8b', required: true }],
        canary: {
          contract: 'exact-token-v1',
          model: 'not-enrolled',
        },
      }).success).toBe(false);
    });

    it('rejects an unrecognised repair action and caller-controlled process fields', () => {
      expect(LocalAiHealthRepairParamsSchema.safeParse({
        provider: 'ollama',
        endpointId: 'ollama',
        action: 'run-command',
      }).success).toBe(false);
      expect(LocalAiHealthRepairParamsSchema.safeParse({
        provider: 'ollama',
        endpointId: 'ollama',
        action: 'restart-ollama',
        executable: '/bin/sh',
      }).success).toBe(false);
    });

    it.each(canonicalRepairOutcomes)(
      'accepts the canonical $outcome repair result tuple',
      (result) => {
        expect(LocalAiHealthRepairResultSchema.safeParse({
          ...repairBase,
          ...result,
        }).success).toBe(true);
      },
    );

    it.each(canonicalRepairOutcomes.flatMap((result) => [
      { ...result, supported: !result.supported },
      { ...result, attempted: !result.attempted },
      { ...result, recovered: !result.recovered },
    ]))('rejects an adjacent contradictory $outcome repair result tuple', (result) => {
      expect(LocalAiHealthRepairResultSchema.safeParse({
        ...repairBase,
        ...result,
      }).success).toBe(false);
    });

    it('normalises a non-serializable service response to the bounded-response error', () => {
      expect(() => parseBoundedServiceRpcResponse(
        LocalAiHealthCheckResultSchema,
        undefined,
      )).toThrow(BoundedServiceRpcResponseError);
    });

    it('rejects non-metadata health layers in diagnose responses', () => {
      expect(LocalAiHealthDiagnoseResultSchema.safeParse({
        targetId: 'ollama',
        checkedAt: 1_700_000_000_000,
        samples: [{
          targetId: 'ollama',
          layer: 'worker',
          checkType: 'functional',
          ok: true,
          required: true,
          affectedRoles: [],
          checkedAt: 1_700_000_000_000,
          durationMs: 1,
          evidence: { workerConnected: true },
        }],
        recommendedActions: [],
      }).success).toBe(false);
    });
  });

  describe('ConfigUpdateParamsSchema', () => {
    it('accepts Android automation updates', () => {
      const result = ConfigUpdateParamsSchema.safeParse({
        androidAutomation: {
          enabled: true,
          sdkPath: 'C:\\Android\\Sdk',
          defaultAvd: 'Pixel_8',
          headlessEmulator: true,
          maxEmulators: 1,
          bootTimeoutMs: 180000,
          allowPhysicalDevices: true,
          injectMaestroMcp: true,
          appiumMcp: false,
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects too many managed emulators', () => {
      const result = ConfigUpdateParamsSchema.safeParse({
        androidAutomation: {
          enabled: true,
          maxEmulators: 5,
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('validateRpcParams', () => {
    it('returns validated data on success', () => {
      const result = validateRpcParams(NodeHeartbeatParamsSchema, {
        nodeId: 'abc',
        capabilities: {
          platform: 'darwin',
          arch: 'arm64',
          cpuCores: 10,
          totalMemoryMB: 36000,
          availableMemoryMB: 20000,
          supportedClis: [],
          hasBrowserRuntime: false,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 5,
          workingDirectories: [],
        },
        activeInstances: 3,
      });
      expect(result.nodeId).toBe('abc');
      expect(result.activeInstances).toBe(3);
    });

    it('throws on invalid data', () => {
      expect(() => validateRpcParams(NodeHeartbeatParamsSchema, {})).toThrow();
    });
  });
});
