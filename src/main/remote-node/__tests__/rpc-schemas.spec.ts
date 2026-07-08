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
  BrowserExtAttachTabParamsSchema,
  BrowserExtPollCommandParamsSchema,
  BrowserExtCommandResultParamsSchema,
  RPC_PARAM_SCHEMAS,
  COORDINATOR_TO_NODE_PARAM_SCHEMAS,
  validateRpcParams,
} from '../rpc-schemas';

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
