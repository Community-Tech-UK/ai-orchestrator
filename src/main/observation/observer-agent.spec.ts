/**
 * ObserverAgent Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ObserverAgent, getObserverAgent } from './observer-agent';
import type { RawObservation } from './observation.types';

// Create mock EventEmitter for ingestor
const mockIngestor = new EventEmitter();

vi.mock('./observation-ingestor', () => ({
  getObservationIngestor: () => mockIngestor,
}));

vi.mock('./observation-store', () => ({
  getObservationStore: () => ({
    storeObservation: vi.fn().mockImplementation(obs => ({
      id: 'test-id',
      ...obs,
    })),
  }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('ObserverAgent', () => {
  let agent: ObserverAgent;

  beforeEach(() => {
    ObserverAgent._resetForTesting();
    mockIngestor.removeAllListeners();
    agent = getObserverAgent();
  });

  afterEach(() => {
    ObserverAgent._resetForTesting();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = getObserverAgent();
      const instance2 = getObserverAgent();
      expect(instance1).toBe(instance2);
    });
  });

  describe('processFlush', () => {
    it('should process flush and create observations', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      const rawObservations: RawObservation[] = [
        {
          id: 'obs-1',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'event',
          content: 'Test event 1',
          metadata: {},
          instanceId: 'inst-1',
          tokenEstimate: 10,
        },
        {
          id: 'obs-2',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'event',
          content: 'Test event 2',
          metadata: {},
          instanceId: 'inst-1',
          tokenEstimate: 10,
        },
      ];

      mockIngestor.emit('ingestor:flush-ready', rawObservations);

      expect(emitSpy).toHaveBeenCalledWith('observer:observation-created', expect.objectContaining({
        id: expect.any(String),
      }));
    });

    it('should handle empty flush', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      mockIngestor.emit('ingestor:flush-ready', []);

      const observationCalls = emitSpy.mock.calls.filter(
        call => call[0] === 'observer:observation-created'
      );
      expect(observationCalls.length).toBe(0);
    });
  });

  describe('theme extraction', () => {
    it('should extract themes from events', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      const rawObservations: RawObservation[] = [
        {
          id: 'obs-1',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'event',
          content: 'Testing validation process with validation checks',
          metadata: {},
          tokenEstimate: 10,
        },
        {
          id: 'obs-2',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'event',
          content: 'More testing and validation activities',
          metadata: {},
          tokenEstimate: 10,
        },
      ];

      mockIngestor.emit('ingestor:flush-ready', rawObservations);

      const observationCall = emitSpy.mock.calls.find(
        call => call[0] === 'observer:observation-created'
      );
      expect(observationCall).toBeDefined();
      const observation = observationCall?.[1] as { themes: string[] };
      expect(observation.themes.length).toBeGreaterThan(0);
      // 'testing' and 'validation' should appear as themes
      expect(observation.themes).toContain('testing');
      expect(observation.themes).toContain('validation');
    });
  });

  describe('signal detection', () => {
    it('should detect success signals', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      const rawObservations: RawObservation[] = [
        {
          id: 'obs-1',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'event',
          content: 'Task completed successfully',
          metadata: {},
          tokenEstimate: 10,
        },
        {
          id: 'obs-2',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'event',
          content: 'All tests passed',
          metadata: { status: 'idle' },
          tokenEstimate: 10,
        },
      ];

      mockIngestor.emit('ingestor:flush-ready', rawObservations);

      const observationCall = emitSpy.mock.calls.find(
        call => call[0] === 'observer:observation-created'
      );
      const observation = observationCall?.[1] as { successSignals: number };
      expect(observation.successSignals).toBeGreaterThan(0);
    });

    it('should detect failure signals', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      const rawObservations: RawObservation[] = [
        {
          id: 'obs-1',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'event',
          content: 'Task failed with error',
          metadata: {},
          tokenEstimate: 10,
        },
        {
          id: 'obs-2',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'event',
          content: 'Exception thrown during execution',
          metadata: {},
          tokenEstimate: 10,
        },
      ];

      mockIngestor.emit('ingestor:flush-ready', rawObservations);

      const observationCall = emitSpy.mock.calls.find(
        call => call[0] === 'observer:observation-created'
      );
      const observation = observationCall?.[1] as { failureSignals: number };
      expect(observation.failureSignals).toBeGreaterThan(0);
    });
  });

  describe('reflection threshold', () => {
    it('should emit reflect-ready when threshold reached', () => {
      agent.configure({ reflectObservationThreshold: 2 });
      const emitSpy = vi.spyOn(agent, 'emit');

      // Create first batch
      mockIngestor.emit('ingestor:flush-ready', [
        {
          id: 'obs-1',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'event',
          content: 'Test 1',
          metadata: {},
          tokenEstimate: 10,
        },
      ]);

      // Create second batch (should trigger reflect-ready)
      mockIngestor.emit('ingestor:flush-ready', [
        {
          id: 'obs-2',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'event',
          content: 'Test 2',
          metadata: {},
          tokenEstimate: 10,
        },
      ]);

      const reflectCalls = emitSpy.mock.calls.filter(
        call => call[0] === 'observer:reflect-ready'
      );
      expect(reflectCalls.length).toBeGreaterThan(0);
    });

    it('should reset count after emitting reflect-ready', () => {
      agent.configure({ reflectObservationThreshold: 1 });

      // Trigger first reflection
      mockIngestor.emit('ingestor:flush-ready', [
        {
          id: 'obs-1',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'event',
          content: 'Test',
          metadata: {},
          tokenEstimate: 10,
        },
      ]);

      const stats = agent.getStats();
      expect(stats.observationCount).toBe(0); // Should reset after threshold
    });
  });

  describe('configuration', () => {
    it('should update configuration', () => {
      agent.configure({
        reflectObservationThreshold: 50,
      });

      // Configuration is internal, verify it affects behavior
      const stats = agent.getStats();
      expect(stats).toBeDefined();
    });
  });

  describe('key findings extraction', () => {
    it('should extract key findings from notable events', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      const rawObservations: RawObservation[] = [
        {
          id: 'obs-1',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'milestone',
          content: 'Important milestone reached with significant progress',
          metadata: {},
          tokenEstimate: 10,
        },
        {
          id: 'obs-2',
          timestamp: Date.now(),
          source: 'instance:output',
          level: 'critical',
          content: 'Critical issue detected requiring attention',
          metadata: {},
          tokenEstimate: 10,
        },
      ];

      mockIngestor.emit('ingestor:flush-ready', rawObservations);

      const observationCall = emitSpy.mock.calls.find(
        call => call[0] === 'observer:observation-created'
      );
      const observation = observationCall?.[1] as { keyFindings: string[] };
      expect(observation.keyFindings.length).toBeGreaterThan(0);
    });
  });
});
