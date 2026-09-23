import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_INTERVAL_MS, RendererHeartbeatService } from './renderer-heartbeat.service';

interface HeartbeatPayload {
  seq: number;
  sentAt: number;
  visibility: 'visible' | 'hidden';
}

interface HeartbeatWindow {
  electronAPI?: {
    rendererHeartbeat?: (payload: HeartbeatPayload) => void;
  };
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('RendererHeartbeatService', () => {
  let service: RendererHeartbeatService;
  let sent: HeartbeatPayload[];

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    (window as unknown as HeartbeatWindow).electronAPI = {
      rendererHeartbeat: (payload) => sent.push(payload),
    };
    service = new RendererHeartbeatService();
  });

  afterEach(() => {
    setVisibility('visible');
    service.stop();
    delete (window as unknown as HeartbeatWindow).electronAPI;
    vi.useRealTimers();
  });

  it('beats immediately on start, then on every interval with increasing seq', () => {
    service.start();
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(sent).toHaveLength(4);
    expect(sent.map((b) => b.seq)).toEqual([0, 1, 2, 3]);
  });

  it('start() is idempotent — one interval no matter how often it is called', () => {
    service.start();
    service.start();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(sent).toHaveLength(2); // initial beat + one tick, not doubled
  });

  it('stop() halts beats', () => {
    service.start();
    service.stop();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5);
    expect(sent).toHaveLength(1); // only the initial beat
  });

  it('is a no-op outside Electron (no preload API)', () => {
    delete (window as unknown as HeartbeatWindow).electronAPI;
    service.start();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(sent).toHaveLength(0);
  });
  it('reports the document visibility with every beat', () => {
    service.start();
    setVisibility('hidden');
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(sent.map((b) => b.visibility)).toEqual(['visible', 'hidden']);
  });

  it('beats immediately when visibility changes, so main learns of throttling before the gap', () => {
    service.start();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(sent).toHaveLength(2);
    expect(sent[1].visibility).toBe('hidden');
  });

  it('stop() removes the visibility listener', () => {
    service.start();
    service.stop();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sent).toHaveLength(1);
  });
});
