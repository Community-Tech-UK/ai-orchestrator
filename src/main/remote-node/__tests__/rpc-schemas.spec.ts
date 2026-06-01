import { describe, it, expect } from 'vitest';
import {
  NodeRegisterParamsSchema,
  NodeHeartbeatParamsSchema,
  TerminalCreateParamsSchema,
  TerminalInputParamsSchema,
  TerminalResizeParamsSchema,
  TerminalKillParamsSchema,
  TerminalOutputParamsSchema,
  TerminalExitParamsSchema,
  ProviderDiagnoseParamsSchema,
  COORDINATOR_TO_NODE_PARAM_SCHEMAS,
  validateRpcParams,
} from '../rpc-schemas';

describe('rpc-schemas', () => {
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
          hasDocker: false,
          maxConcurrentInstances: 10,
          workingDirectories: ['/tmp'],
        },
        token: 'secret-token',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing nodeId', () => {
      const result = NodeRegisterParamsSchema.safeParse({ name: 'test' });
      expect(result.success).toBe(false);
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
