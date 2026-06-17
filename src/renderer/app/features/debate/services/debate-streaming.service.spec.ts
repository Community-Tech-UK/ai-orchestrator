import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from '../../../core/services/ipc';
import { DebateStreamingService } from './debate-streaming.service';

describe('DebateStreamingService', () => {
  let service: DebateStreamingService;
  let api: {
    debateStart: ReturnType<typeof vi.fn>;
    onDebateEvent: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    api = {
      debateStart: vi.fn(),
      onDebateEvent: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        DebateStreamingService,
        { provide: ElectronIpcService, useValue: { getApi: () => api } },
      ],
    });

    service = TestBed.inject(DebateStreamingService);
  });

  it('maps renderer agentCount config to the backend agents field', async () => {
    api.debateStart.mockResolvedValue('debate-1');

    await service.startDebate('Which design is safer?', {
      agentCount: 5,
      maxRounds: 3,
      convergenceThreshold: 0.7,
    });

    expect(api.debateStart).toHaveBeenCalledWith({
      query: 'Which design is safer?',
      config: {
        agents: 5,
        maxRounds: 3,
        convergenceThreshold: 0.7,
      },
    });
  });

  it('accepts the raw debate id returned by the main-process handler', async () => {
    api.debateStart.mockResolvedValue('debate-raw-id');

    const sessionId = await service.startDebate('Raw handler result?');

    expect(sessionId).toBe('debate-raw-id');
    expect(service.state().sessionId).toBe('debate-raw-id');
    expect(service.state().totalRounds).toBe(2);
  });

  it('still accepts wrapped IpcResponse debate ids', async () => {
    api.debateStart.mockResolvedValue({ success: true, data: { sessionId: 'debate-wrapped-id' } });

    const sessionId = await service.startDebate('Wrapped handler result?', { maxRounds: 4 });

    expect(sessionId).toBe('debate-wrapped-id');
    expect(service.state().totalRounds).toBe(4);
  });
});
