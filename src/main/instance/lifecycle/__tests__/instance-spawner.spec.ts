import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstanceSpawner } from '../instance-spawner';

describe('InstanceSpawner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an adapter and launches process', async () => {
    const mockAdapterFactory = vi.fn().mockResolvedValue({
      spawn: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      pid: 12345,
    });

    const spawner = new InstanceSpawner({ createAdapter: mockAdapterFactory });
    const result = await spawner.spawn({
      instanceId: 'test-1',
      workingDirectory: '/tmp/test',
      provider: 'claude-cli',
      model: 'claude-sonnet-4-6',
    });

    expect(mockAdapterFactory).toHaveBeenCalledOnce();
    expect(result.adapter).toBeDefined();
    expect(result.pid).toBe(12345);
  });

  it('loads instructions when loadInstructions dep is provided', async () => {
    const loadInstructions = vi.fn().mockResolvedValue('# Instructions\nBe helpful.');
    const spawner = new InstanceSpawner({
      createAdapter: vi.fn().mockResolvedValue({ spawn: vi.fn(), on: vi.fn(), pid: 1 }),
      loadInstructions,
    });

    await spawner.spawn({
      instanceId: 'test-2',
      workingDirectory: '/tmp/test',
      provider: 'claude-cli',
    });

    expect(loadInstructions).toHaveBeenCalledWith('/tmp/test');
  });

  it('does not call loadInstructions when dep is not provided', async () => {
    const spawnMock = vi.fn().mockResolvedValue(undefined);
    const spawner = new InstanceSpawner({
      createAdapter: vi.fn().mockResolvedValue({ spawn: spawnMock, on: vi.fn(), pid: 2 }),
    });

    await spawner.spawn({
      instanceId: 'test-3',
      workingDirectory: '/tmp/test',
      provider: 'gemini-cli',
    });

    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('returns sessionId from config in result', async () => {
    const spawner = new InstanceSpawner({
      createAdapter: vi.fn().mockResolvedValue({ spawn: vi.fn(), on: vi.fn(), pid: 99 }),
    });

    const result = await spawner.spawn({
      instanceId: 'test-4',
      workingDirectory: '/tmp/test',
      provider: 'claude-cli',
      sessionId: 'my-session-id',
    });

    expect(result.sessionId).toBe('my-session-id');
    expect(result.pid).toBe(99);
  });

  it('passes spawn args including instructions to adapter.spawn', async () => {
    const spawnMock = vi.fn().mockResolvedValue(undefined);
    const loadInstructions = vi.fn().mockResolvedValue('# Do good work.');
    const spawner = new InstanceSpawner({
      createAdapter: vi.fn().mockResolvedValue({ spawn: spawnMock, on: vi.fn(), pid: 5 }),
      loadInstructions,
    });

    await spawner.spawn({
      instanceId: 'test-5',
      workingDirectory: '/tmp/project',
      provider: 'claude-cli',
      model: 'claude-opus-4-5',
      sessionId: 'sess-abc',
      yoloMode: true,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: '/tmp/project',
        model: 'claude-opus-4-5',
        sessionId: 'sess-abc',
        yoloMode: true,
        instructions: '# Do good work.',
      })
    );
  });
});
