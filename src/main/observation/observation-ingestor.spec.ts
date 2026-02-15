/**
 * ObservationIngestor Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ObservationIngestor, getObservationIngestor } from './observation-ingestor';
import type { InstanceManager } from '../instance/instance-manager';

// Mock dependencies
vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('ObservationIngestor', () => {
  let ingestor: ObservationIngestor;
  let mockInstanceManager: InstanceManager;

  beforeEach(() => {
    ObservationIngestor._resetForTesting();
    ingestor = getObservationIngestor();
    mockInstanceManager = new EventEmitter() as unknown as InstanceManager;
  });

  afterEach(() => {
    ObservationIngestor._resetForTesting();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = getObservationIngestor();
      const instance2 = getObservationIngestor();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialization', () => {
    it('should initialize and attach listeners', () => {
      const listenerCountBefore = mockInstanceManager.listenerCount('instance:output');

      ingestor.initialize(mockInstanceManager);

      const listenerCountAfter = mockInstanceManager.listenerCount('instance:output');
      expect(listenerCountAfter).toBeGreaterThan(listenerCountBefore);
    });

    it('should not initialize twice', () => {
      ingestor.initialize(mockInstanceManager);
      const listenerCountAfter1 = mockInstanceManager.listenerCount('instance:output');

      ingestor.initialize(mockInstanceManager);
      const listenerCountAfter2 = mockInstanceManager.listenerCount('instance:output');

      expect(listenerCountAfter1).toBe(listenerCountAfter2);
    });
  });

  describe('event capture', () => {
    beforeEach(() => {
      ingestor.initialize(mockInstanceManager);
    });

    it('should capture events from instance output', () => {
      const bufferSizeBefore = ingestor.getBufferSize();

      mockInstanceManager.emit('instance:output', {
        instanceId: 'inst-1',
        message: { type: 'text', content: 'Hello world' },
      });

      const bufferSizeAfter = ingestor.getBufferSize();
      expect(bufferSizeAfter).toBeGreaterThan(bufferSizeBefore);
    });

    it('should capture instance state updates', () => {
      const bufferSizeBefore = ingestor.getBufferSize();

      mockInstanceManager.emit('instance:state-update', {
        instanceId: 'inst-1',
        status: 'idle',
      });

      const bufferSizeAfter = ingestor.getBufferSize();
      expect(bufferSizeAfter).toBeGreaterThan(bufferSizeBefore);
    });

    it('should handle malformed events gracefully', () => {
      const bufferSizeBefore = ingestor.getBufferSize();

      // Emit malformed events
      mockInstanceManager.emit('instance:output', null);
      mockInstanceManager.emit('instance:output', { instanceId: 'inst-1' }); // Missing message
      mockInstanceManager.emit('instance:output', { message: {} }); // Missing instanceId

      const bufferSizeAfter = ingestor.getBufferSize();
      expect(bufferSizeAfter).toBe(bufferSizeBefore); // Should not capture invalid events
    });
  });

  describe('flush behavior', () => {
    beforeEach(() => {
      ingestor.initialize(mockInstanceManager);
      ingestor.configure({ observeTokenThreshold: 100 });
    });

    it('should flush when token threshold reached', () => {
      const emitSpy = vi.spyOn(ingestor, 'emit');

      // Capture enough events to trigger flush
      for (let i = 0; i < 50; i++) {
        mockInstanceManager.emit('instance:output', {
          instanceId: 'inst-1',
          message: { type: 'text', content: 'This is a longer message that will contribute to token count and eventually trigger a flush' },
        });
      }

      expect(emitSpy).toHaveBeenCalledWith('ingestor:flush-ready', expect.any(Array));
    });

    it('should reset buffer after flush', () => {
      ingestor.configure({ observeTokenThreshold: 50 });

      // Trigger flush
      for (let i = 0; i < 20; i++) {
        mockInstanceManager.emit('instance:output', {
          instanceId: 'inst-1',
          message: { type: 'text', content: 'Message that adds tokens to buffer' },
        });
      }

      // Check buffer is empty after flush
      const bufferSize = ingestor.getBufferSize();
      expect(bufferSize).toBe(0);
    });
  });

  describe('privacy filtering', () => {
    beforeEach(() => {
      ingestor.initialize(mockInstanceManager);
      ingestor.configure({ enablePrivacyFiltering: true });
    });

    it('should apply privacy filtering when enabled', () => {
      const emitSpy = vi.spyOn(ingestor, 'emit');

      mockInstanceManager.emit('instance:output', {
        instanceId: 'inst-1',
        message: {
          type: 'text',
          content: 'Check this URL: https://example.com/secret and path: /home/user/documents',
        },
      });

      ingestor.forceFlush();

      expect(emitSpy).toHaveBeenCalled();
      const flushCall = emitSpy.mock.calls.find(call => call[0] === 'ingestor:flush-ready');
      if (flushCall) {
        const observations = flushCall[1] as { content: string }[];
        expect(observations[0].content).toContain('<URL>');
        expect(observations[0].content).toContain('<PATH>');
      }
    });

    it('should preserve original content when filtering disabled', () => {
      ingestor.configure({ enablePrivacyFiltering: false });
      const emitSpy = vi.spyOn(ingestor, 'emit');

      const originalContent = 'Check this URL: https://example.com/secret';
      mockInstanceManager.emit('instance:output', {
        instanceId: 'inst-1',
        message: { type: 'text', content: originalContent },
      });

      ingestor.forceFlush();

      const flushCall = emitSpy.mock.calls.find(call => call[0] === 'ingestor:flush-ready');
      if (flushCall) {
        const observations = flushCall[1] as { content: string }[];
        expect(observations[0].content).toContain('https://example.com/secret');
      }
    });
  });

  describe('minimum level filtering', () => {
    beforeEach(() => {
      ingestor.initialize(mockInstanceManager);
    });

    it('should respect minimum level', () => {
      ingestor.configure({ minLevel: 'milestone' });

      // Directly capture events with different levels
      ingestor.captureEvent('instance:output', 'trace', 'Trace event', {}, 'inst-1');
      ingestor.captureEvent('instance:output', 'event', 'Event level', {}, 'inst-1');
      ingestor.captureEvent('instance:output', 'milestone', 'Milestone event', {}, 'inst-1');

      const bufferSize = ingestor.getBufferSize();
      // Only milestone should be captured (minLevel is 'milestone')
      expect(bufferSize).toBe(1);
    });

    it('should capture events at or above minimum level', () => {
      ingestor.configure({ minLevel: 'event' });

      ingestor.captureEvent('instance:output', 'trace', 'Trace event', {}, 'inst-1');
      ingestor.captureEvent('instance:output', 'event', 'Event level', {}, 'inst-1');
      ingestor.captureEvent('instance:output', 'milestone', 'Milestone event', {}, 'inst-1');
      ingestor.captureEvent('instance:output', 'critical', 'Critical event', {}, 'inst-1');

      const bufferSize = ingestor.getBufferSize();
      // event, milestone, and critical should be captured (3 total)
      expect(bufferSize).toBe(3);
    });
  });

  describe('forceFlush', () => {
    beforeEach(() => {
      ingestor.initialize(mockInstanceManager);
    });

    it('should force flush regardless of thresholds', () => {
      const emitSpy = vi.spyOn(ingestor, 'emit');

      // Capture a few events (not enough to trigger automatic flush)
      mockInstanceManager.emit('instance:output', {
        instanceId: 'inst-1',
        message: { type: 'text', content: 'Test message' },
      });

      ingestor.forceFlush();

      expect(emitSpy).toHaveBeenCalledWith('ingestor:flush-ready', expect.any(Array));
    });

    it('should not emit if buffer is empty', () => {
      const emitSpy = vi.spyOn(ingestor, 'emit');

      ingestor.forceFlush();

      const flushCalls = emitSpy.mock.calls.filter(call => call[0] === 'ingestor:flush-ready');
      expect(flushCalls.length).toBe(0);
    });
  });

  describe('getStats', () => {
    beforeEach(() => {
      ingestor.initialize(mockInstanceManager);
    });

    it('should return current stats', () => {
      mockInstanceManager.emit('instance:output', {
        instanceId: 'inst-1',
        message: { type: 'text', content: 'Test' },
      });

      const stats = ingestor.getStats();

      expect(stats).toBeDefined();
      expect(stats).toHaveProperty('totalCaptured');
      expect(stats).toHaveProperty('bufferSize');
      expect(stats).toHaveProperty('cumulativeTokens');
      expect(stats).toHaveProperty('lastFlushTimestamp');
      expect(stats.totalCaptured).toBeGreaterThan(0);
    });
  });
});
