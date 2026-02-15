/**
 * ReflectorAgent Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ReflectorAgent, getReflectorAgent } from './reflector-agent';
import type { Observation } from '../../shared/types/observation.types';

// Create mock EventEmitter for observer
const mockObserver = new EventEmitter();

vi.mock('./observer-agent', () => ({
  getObserverAgent: () => mockObserver,
}));

vi.mock('./observation-store', () => ({
  getObservationStore: () => ({
    storeReflection: vi.fn().mockImplementation(ref => ({
      id: 'ref-id',
      ...ref,
    })),
    promoteReflection: vi.fn().mockReturnValue(true),
  }),
}));

vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({
    updateObservation: vi.fn(),
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

describe('ReflectorAgent', () => {
  let agent: ReflectorAgent;

  beforeEach(() => {
    ReflectorAgent._resetForTesting();
    mockObserver.removeAllListeners();
    agent = getReflectorAgent();
  });

  afterEach(() => {
    ReflectorAgent._resetForTesting();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = getReflectorAgent();
      const instance2 = getReflectorAgent();
      expect(instance1).toBe(instance2);
    });
  });

  describe('reflection creation', () => {
    it('should create reflection from clustered observations', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      const observation1: Observation = {
        id: 'obs-1',
        summary: 'Test observation 1',
        sourceIds: ['src-1'],
        instanceIds: ['inst-1'],
        themes: ['testing', 'validation'],
        keyFindings: ['Finding 1'],
        successSignals: 5,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 50,
      };

      const observation2: Observation = {
        id: 'obs-2',
        summary: 'Test observation 2',
        sourceIds: ['src-2'],
        instanceIds: ['inst-2'],
        themes: ['testing', 'verification'],
        keyFindings: ['Finding 2'],
        successSignals: 3,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 45,
      };

      // Emit observations
      mockObserver.emit('observer:observation-created', observation1);
      mockObserver.emit('observer:observation-created', observation2);

      // Trigger reflection
      mockObserver.emit('observer:reflect-ready');

      const reflectionCalls = emitSpy.mock.calls.filter(
        call => call[0] === 'reflector:reflection-created'
      );
      expect(reflectionCalls.length).toBeGreaterThan(0);
    });

    it('should not create reflection from single observation', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      const observation: Observation = {
        id: 'obs-1',
        summary: 'Single observation',
        sourceIds: ['src-1'],
        instanceIds: ['inst-1'],
        themes: ['testing'],
        keyFindings: ['Finding'],
        successSignals: 2,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 30,
      };

      mockObserver.emit('observer:observation-created', observation);
      mockObserver.emit('observer:reflect-ready');

      const reflectionCalls = emitSpy.mock.calls.filter(
        call => call[0] === 'reflector:reflection-created'
      );
      // Should not create reflection from cluster of size 1
      expect(reflectionCalls.length).toBe(0);
    });
  });

  describe('theme similarity clustering', () => {
    it('should cluster observations by theme similarity', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      // Similar themes - should cluster together
      const obs1: Observation = {
        id: 'obs-1',
        summary: 'Obs 1',
        sourceIds: ['src-1'],
        instanceIds: ['inst-1'],
        themes: ['performance', 'caching', 'optimization'],
        keyFindings: ['Cache hit rate improved'],
        successSignals: 3,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 40,
      };

      const obs2: Observation = {
        id: 'obs-2',
        summary: 'Obs 2',
        sourceIds: ['src-2'],
        instanceIds: ['inst-2'],
        themes: ['performance', 'optimization', 'speed'],
        keyFindings: ['Response time reduced'],
        successSignals: 4,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 35,
      };

      // Different themes - should not cluster together
      const obs3: Observation = {
        id: 'obs-3',
        summary: 'Obs 3',
        sourceIds: ['src-3'],
        instanceIds: ['inst-3'],
        themes: ['security', 'authentication', 'authorization'],
        keyFindings: ['Auth checks passed'],
        successSignals: 2,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 30,
      };

      mockObserver.emit('observer:observation-created', obs1);
      mockObserver.emit('observer:observation-created', obs2);
      mockObserver.emit('observer:observation-created', obs3);
      mockObserver.emit('observer:reflect-ready');

      const reflectionCalls = emitSpy.mock.calls.filter(
        call => call[0] === 'reflector:reflection-created'
      );

      // Should create at least one reflection (obs1 and obs2 should cluster)
      expect(reflectionCalls.length).toBeGreaterThan(0);
    });
  });

  describe('confidence calculation', () => {
    it('should calculate confidence based on cluster properties', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      const obs1: Observation = {
        id: 'obs-1',
        summary: 'Obs 1',
        sourceIds: ['src-1'],
        instanceIds: ['inst-1'],
        themes: ['testing'],
        keyFindings: ['Finding 1'],
        successSignals: 5,
        failureSignals: 0, // Consistent signal
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 40,
      };

      const obs2: Observation = {
        id: 'obs-2',
        summary: 'Obs 2',
        sourceIds: ['src-2'],
        instanceIds: ['inst-2'],
        themes: ['testing'],
        keyFindings: ['Finding 2'],
        successSignals: 4,
        failureSignals: 0, // Consistent signal
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 35,
      };

      mockObserver.emit('observer:observation-created', obs1);
      mockObserver.emit('observer:observation-created', obs2);
      mockObserver.emit('observer:reflect-ready');

      const reflectionCall = emitSpy.mock.calls.find(
        call => call[0] === 'reflector:reflection-created'
      );

      expect(reflectionCall).toBeDefined();
      const reflection = reflectionCall?.[1] as { confidence: number };
      expect(reflection.confidence).toBeGreaterThan(0);
      expect(reflection.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('pattern extraction', () => {
    it('should extract patterns from observations', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      const obs1: Observation = {
        id: 'obs-1',
        summary: 'Success pattern test',
        sourceIds: ['src-1'],
        instanceIds: ['inst-1'],
        themes: ['success', 'completion'],
        keyFindings: ['Task completed successfully'],
        successSignals: 10,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 40,
      };

      const obs2: Observation = {
        id: 'obs-2',
        summary: 'Another success',
        sourceIds: ['src-2'],
        instanceIds: ['inst-2'],
        themes: ['success', 'completion'],
        keyFindings: ['All checks passed'],
        successSignals: 8,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 35,
      };

      mockObserver.emit('observer:observation-created', obs1);
      mockObserver.emit('observer:observation-created', obs2);
      mockObserver.emit('observer:reflect-ready');

      const reflectionCall = emitSpy.mock.calls.find(
        call => call[0] === 'reflector:reflection-created'
      );

      const reflection = reflectionCall?.[1] as { patterns: { type: string }[] };
      expect(reflection.patterns.length).toBeGreaterThan(0);

      // Should include success_pattern type
      const hasSuccessPattern = reflection.patterns.some(p => p.type === 'success_pattern');
      expect(hasSuccessPattern).toBe(true);
    });

    it('should detect cross-instance patterns', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      const obs1: Observation = {
        id: 'obs-1',
        summary: 'Instance 1',
        sourceIds: ['src-1'],
        instanceIds: ['inst-1', 'inst-2'], // Multiple instances
        themes: ['distributed', 'pattern'],
        keyFindings: ['Pattern across instances'],
        successSignals: 3,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 40,
      };

      const obs2: Observation = {
        id: 'obs-2',
        summary: 'Instance 2',
        sourceIds: ['src-2'],
        instanceIds: ['inst-3', 'inst-4'], // Different instances
        themes: ['distributed', 'pattern'],
        keyFindings: ['Consistent behavior'],
        successSignals: 2,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 35,
      };

      mockObserver.emit('observer:observation-created', obs1);
      mockObserver.emit('observer:observation-created', obs2);
      mockObserver.emit('observer:reflect-ready');

      const reflectionCall = emitSpy.mock.calls.find(
        call => call[0] === 'reflector:reflection-created'
      );

      const reflection = reflectionCall?.[1] as { patterns: { type: string }[] };
      const hasCrossInstance = reflection.patterns.some(p => p.type === 'cross_instance');
      expect(hasCrossInstance).toBe(true);
    });
  });

  describe('forceReflect', () => {
    it('should process pending observations immediately', () => {
      const emitSpy = vi.spyOn(agent, 'emit');

      const obs1: Observation = {
        id: 'obs-1',
        summary: 'Pending obs 1',
        sourceIds: ['src-1'],
        instanceIds: ['inst-1'],
        themes: ['forced'],
        keyFindings: ['Finding'],
        successSignals: 2,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 30,
      };

      const obs2: Observation = {
        id: 'obs-2',
        summary: 'Pending obs 2',
        sourceIds: ['src-2'],
        instanceIds: ['inst-2'],
        themes: ['forced'],
        keyFindings: ['Finding'],
        successSignals: 1,
        failureSignals: 0,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ttl: 86400000,
        promoted: false,
        tokenCount: 30,
      };

      mockObserver.emit('observer:observation-created', obs1);
      mockObserver.emit('observer:observation-created', obs2);

      // Force reflection without waiting for reflect-ready
      agent.forceReflect();

      const reflectionCalls = emitSpy.mock.calls.filter(
        call => call[0] === 'reflector:reflection-created'
      );
      expect(reflectionCalls.length).toBeGreaterThan(0);
    });
  });

  describe('configuration', () => {
    it('should update configuration', () => {
      agent.configure({
        promotionConfidenceThreshold: 0.95,
        promotionUsageThreshold: 20,
      });

      // Configuration is internal, verify it's accepted without error
      expect(agent).toBeDefined();
    });
  });
});
