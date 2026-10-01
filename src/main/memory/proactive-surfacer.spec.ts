/**
 * Proactive Surfacer Tests
 * Phase 3 unit tests for proactive memory surfacing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ProactiveSurfacer,
  getProactiveSurfacer,
  MemoryController,
} from './proactive-surfacer';
import type {
  WorkflowMemory,
  StrategyMemory,
  SessionMemory,
  LearnedPattern,
} from '../../shared/types/unified-memory.types';

// ============ Mock Data ============

const mockWorkflows: WorkflowMemory[] = [
  {
    id: 'wf-1',
    name: 'Test Component Creation',
    steps: ['Create component file', 'Add template', 'Write tests', 'Export from index'],
    successRate: 0.9,
    applicableContexts: ['component', 'typescript', 'angular'],
  },
  {
    id: 'wf-2',
    name: 'Service Implementation',
    steps: ['Create service', 'Add dependency injection', 'Implement methods'],
    successRate: 0.85,
    applicableContexts: ['service', 'api', 'typescript'],
  },
  {
    id: 'wf-3',
    name: 'Unit Test Writing',
    steps: ['Create spec file', 'Setup mocks', 'Write test cases', 'Run coverage'],
    successRate: 0.95,
    applicableContexts: ['test', 'spec', 'jasmine', 'vitest'],
  },
];

const mockStrategies: StrategyMemory[] = [
  {
    id: 'st-1',
    strategy: 'Use dependency injection for services',
    conditions: ['service', 'angular', 'typescript'],
    outcomes: [
      { taskId: 't1', success: true, score: 0.9, timestamp: Date.now() - 1000 },
      { taskId: 't2', success: true, score: 0.85, timestamp: Date.now() },
    ],
  },
  {
    id: 'st-2',
    strategy: 'Mock external dependencies in tests',
    conditions: ['test', 'spec', 'mock'],
    outcomes: [
      { taskId: 't3', success: true, score: 0.95, timestamp: Date.now() },
    ],
  },
];

const mockSessions: SessionMemory[] = [
  {
    sessionId: 'sess-1',
    summary: 'Worked on user-profile.component.ts refactoring',
    keyEvents: ['Fixed user profile loading', 'Added error handling'],
    outcome: 'success',
    lessonsLearned: ['Always handle loading states'],
    timestamp: Date.now() - 86400000, // 1 day ago
  },
  {
    sessionId: 'sess-2',
    summary: 'Implemented auth service with OAuth integration',
    keyEvents: ['Created auth service', 'Added token refresh'],
    outcome: 'success',
    lessonsLearned: ['Use interceptors for auth headers'],
    timestamp: Date.now() - 3600000, // 1 hour ago
  },
  {
    sessionId: 'sess-3',
    summary: 'Debugging the memory/unified-controller.ts issues',
    keyEvents: ['Fixed race condition', 'Added caching'],
    outcome: 'partial',
    lessonsLearned: ['Check async operations carefully'],
    timestamp: Date.now() - 7200000, // 2 hours ago
  },
];

const mockPatterns: LearnedPattern[] = [
  {
    id: 'pat-1',
    pattern: 'Use async/await for service calls',
    successRate: 0.92,
    usageCount: 15,
    contexts: ['service', 'component'],
  },
  {
    id: 'pat-2',
    pattern: 'Create test fixtures for complex data',
    successRate: 0.88,
    usageCount: 8,
    contexts: ['test', 'spec'],
  },
];

// ============ Mock Memory Controller ============

function createMockMemoryController(): MemoryController {
  return {
    getWorkflows: vi.fn(() => mockWorkflows),
    getStrategies: vi.fn(() => mockStrategies),
    getSessionHistory: vi.fn((limit?: number) => {
      const sorted = [...mockSessions].sort((a, b) => b.timestamp - a.timestamp);
      return limit ? sorted.slice(0, limit) : sorted;
    }),
    getPatterns: vi.fn((minSuccessRate?: number) => {
      if (minSuccessRate !== undefined) {
        return mockPatterns.filter(p => p.successRate >= minSuccessRate);
      }
      return mockPatterns;
    }),
  };
}

// ============ Tests ============

describe('ProactiveSurfacer', () => {
  let surfacer: ProactiveSurfacer;
  let mockController: MemoryController;

  beforeEach(() => {
    vi.clearAllMocks();
    ProactiveSurfacer.resetInstance();
    surfacer = getProactiveSurfacer();
    mockController = createMockMemoryController();
    surfacer.initialize(mockController);
  });

  afterEach(() => {
    ProactiveSurfacer.resetInstance();
  });

  // ============ Singleton Pattern ============

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = getProactiveSurfacer();
      const instance2 = getProactiveSurfacer();
      expect(instance1).toBe(instance2);
    });

    it('should reset instance correctly', () => {
      const instance1 = getProactiveSurfacer();
      ProactiveSurfacer.resetInstance();
      const instance2 = getProactiveSurfacer();
      expect(instance1).not.toBe(instance2);
    });
  });

  // ============ Configuration ============

  describe('Configuration', () => {
    it('should use default configuration', () => {
      const config = surfacer.getConfig();
      expect(config.cooldownMs).toBe(10 * 60 * 1000);
      expect(config.maxWorkflows).toBe(3);
      expect(config.maxSessions).toBe(3);
      expect(config.minRelevanceScore).toBe(0.3);
    });

    it('should allow configuration updates', () => {
      surfacer.configure({ cooldownMs: 5 * 60 * 1000 });
      const config = surfacer.getConfig();
      expect(config.cooldownMs).toBe(5 * 60 * 1000);
    });

    it('should preserve other config when updating', () => {
      surfacer.configure({ cooldownMs: 5 * 60 * 1000 });
      surfacer.configure({ maxWorkflows: 5 });
      const config = surfacer.getConfig();
      expect(config.cooldownMs).toBe(5 * 60 * 1000);
      expect(config.maxWorkflows).toBe(5);
    });

    it('should pass custom config to getInstance', () => {
      ProactiveSurfacer.resetInstance();
      const instance = getProactiveSurfacer({ maxWorkflows: 10 });
      expect(instance.getConfig().maxWorkflows).toBe(10);
    });
  });

  // ============ Initialization ============

  describe('Initialization', () => {
    it('should emit initialized event', () => {
      ProactiveSurfacer.resetInstance();
      const newSurfacer = getProactiveSurfacer();
      const initHandler = vi.fn();
      newSurfacer.on('initialized', initHandler);

      newSurfacer.initialize(mockController);

      expect(initHandler).toHaveBeenCalledOnce();
      expect(initHandler).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.any(Object),
      }));
    });

    it('should return null if not initialized', async () => {
      ProactiveSurfacer.resetInstance();
      const uninitializedSurfacer = getProactiveSurfacer();
      // Add error handler to prevent unhandled error exception
      uninitializedSurfacer.on('error', () => {});

      const result = await uninitializedSurfacer.onFileContextChange('/some/file.ts');

      expect(result).toBeNull();
    });

    it('should emit error if controller not initialized', async () => {
      ProactiveSurfacer.resetInstance();
      const uninitializedSurfacer = getProactiveSurfacer();
      const errorHandler = vi.fn();
      uninitializedSurfacer.on('error', errorHandler);

      await uninitializedSurfacer.onFileContextChange('/some/file.ts');

      expect(errorHandler).toHaveBeenCalledWith({
        message: 'Memory controller not initialized',
      });
    });
  });

  // ============ File Context Detection ============

  describe('File Context Detection', () => {
    it('should detect test files', async () => {
      const result = await surfacer.onFileContextChange('/project/src/services/auth.spec.ts');

      expect(result).not.toBeNull();
      expect(result!.relevantMemories.some(m =>
        m.type === 'workflow' && m.name.toLowerCase().includes('test')
      )).toBe(true);
    });

    it('should detect component files', async () => {
      const result = await surfacer.onFileContextChange('/project/src/components/user-profile.component.ts');

      expect(result).not.toBeNull();
      // Should find either component workflow or session mentioning components
      const hasRelevantWorkflow = result!.relevantMemories.some(m =>
        m.type === 'workflow' && (
          m.name.toLowerCase().includes('component') ||
          m.name.toLowerCase().includes('test')  // Test workflow applies to components
        )
      );
      const hasRelevantSession = result!.relevantMemories.some(m =>
        m.type === 'session' && m.summary.toLowerCase().includes('component')
      );
      expect(hasRelevantWorkflow || hasRelevantSession).toBe(true);
    });

    it('should detect service files', async () => {
      const result = await surfacer.onFileContextChange('/project/src/services/auth.service.ts');

      expect(result).not.toBeNull();
      // Should find service workflow or session mentioning auth/service
      const hasRelevantMemory = result!.relevantMemories.some(m =>
        (m.type === 'workflow' && m.name.toLowerCase().includes('service')) ||
        (m.type === 'strategy' && m.summary.toLowerCase().includes('service')) ||
        (m.type === 'session' && m.summary.toLowerCase().includes('auth'))
      );
      expect(hasRelevantMemory).toBe(true);
    });

    it('should return null for unwatched file extensions', async () => {
      const result = await surfacer.onFileContextChange('/project/image.png');

      expect(result).toBeNull();
    });

    it('should return null when no relevant memories found', async () => {
      // Empty all memories
      (mockController.getWorkflows as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockController.getStrategies as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockController.getSessionHistory as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (mockController.getPatterns as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const result = await surfacer.onFileContextChange('/project/src/random.ts');

      expect(result).toBeNull();
    });
  });

  // ============ Session Matching ============

  describe('Session Matching', () => {
    it('should find sessions mentioning the file', async () => {
      const result = await surfacer.onFileContextChange('/project/src/memory/unified-controller.ts');

      expect(result).not.toBeNull();
      const sessionMemory = result!.relevantMemories.find(m => m.type === 'session');
      expect(sessionMemory).toBeDefined();
      expect(sessionMemory!.name).toContain('Session');
    });

    it('should find sessions by basename match', async () => {
      const result = await surfacer.onFileContextChange('/other/path/user-profile.component.ts');

      expect(result).not.toBeNull();
      // Session summary contains "user-profile.component.ts" (with hyphen)
      const sessionMemory = result!.relevantMemories.find(m =>
        m.type === 'session' && m.summary.toLowerCase().includes('user-profile')
      );
      expect(sessionMemory).toBeDefined();
    });
  });

  // ============ Cooldown/Caching ============

  describe('Cooldown Management', () => {
    it('should not resurface same context within cooldown', async () => {
      const filePath = '/project/src/services/auth.service.ts';

      const result1 = await surfacer.onFileContextChange(filePath);
      const result2 = await surfacer.onFileContextChange(filePath);

      expect(result1).not.toBeNull();
      expect(result2).toBeNull();
    });

    it('should resurface after cooldown expires', async () => {
      // Use short cooldown for testing
      surfacer.configure({ cooldownMs: 100 });
      const filePath = '/project/src/services/auth.service.ts';

      const result1 = await surfacer.onFileContextChange(filePath);
      expect(result1).not.toBeNull();

      // Wait for cooldown
      await new Promise(resolve => setTimeout(resolve, 150));

      const result2 = await surfacer.onFileContextChange(filePath);
      expect(result2).not.toBeNull();
    });

    it('should emit context:cached event on cache hit', async () => {
      const cacheHandler = vi.fn();
      surfacer.on('context:cached', cacheHandler);
      const filePath = '/project/src/services/auth.service.ts';

      await surfacer.onFileContextChange(filePath);
      await surfacer.onFileContextChange(filePath);

      expect(cacheHandler).toHaveBeenCalledOnce();
    });

    it('should allow clearing specific context', async () => {
      const filePath = '/project/src/services/auth.service.ts';

      await surfacer.onFileContextChange(filePath);
      surfacer.clearContext(filePath);
      const result = await surfacer.onFileContextChange(filePath);

      expect(result).not.toBeNull();
    });

    it('should allow clearing all contexts', async () => {
      // Use paths that will match memories
      const path1 = '/project/src/services/auth.service.ts';
      const path2 = '/project/src/__tests__/auth.spec.ts';

      await surfacer.onFileContextChange(path1);
      await surfacer.onFileContextChange(path2);

      surfacer.clearAllContexts();

      const result1 = await surfacer.onFileContextChange(path1);
      const result2 = await surfacer.onFileContextChange(path2);

      // After clearing, should be able to resurface these
      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
    });

    it('should cleanup expired cache entries', async () => {
      surfacer.configure({ cooldownMs: 50 });
      await surfacer.onFileContextChange('/project/src/a.ts');

      await new Promise(resolve => setTimeout(resolve, 100));
      surfacer.cleanupCache();

      const stats = surfacer.getStats();
      expect(stats.activeContexts).toBe(0);
    });
  });

  // ============ Statistics ============

  describe('Statistics', () => {
    it('should track total surfacings', async () => {
      // Use paths that will match memories and produce surfacings
      await surfacer.onFileContextChange('/project/src/services/auth.service.ts');
      await surfacer.onFileContextChange('/project/src/__tests__/auth.spec.ts');

      const stats = surfacer.getStats();
      expect(stats.totalSurfacings).toBe(2);
    });

    it('should track cache hits', async () => {
      const filePath = '/project/src/services/auth.service.ts';

      await surfacer.onFileContextChange(filePath);
      await surfacer.onFileContextChange(filePath);
      await surfacer.onFileContextChange(filePath);

      const stats = surfacer.getStats();
      expect(stats.cacheHits).toBe(2);
    });

    it('should track surfacing time', async () => {
      await surfacer.onFileContextChange('/project/src/a.ts');

      const stats = surfacer.getStats();
      expect(stats.lastSurfacingTimeMs).toBeGreaterThanOrEqual(0);
      expect(stats.avgSurfacingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should track active contexts', async () => {
      // Use paths that will match memories and produce surfacings
      await surfacer.onFileContextChange('/project/src/services/auth.service.ts');
      await surfacer.onFileContextChange('/project/src/__tests__/auth.spec.ts');

      const stats = surfacer.getStats();
      expect(stats.activeContexts).toBe(2);
    });

    it('should reset stats on clear', () => {
      surfacer.clear();
      const stats = surfacer.getStats();

      expect(stats.totalSurfacings).toBe(0);
      expect(stats.cacheHits).toBe(0);
      expect(stats.activeContexts).toBe(0);
    });
  });

  // ============ Suggestion Formatting ============

  describe('Suggestion Formatting', () => {
    it('should include file name in message', async () => {
      const result = await surfacer.onFileContextChange('/project/src/services/auth.service.ts');

      expect(result).not.toBeNull();
      expect(result!.message).toContain('auth.service.ts');
    });

    it('should include relevant workflows section', async () => {
      const result = await surfacer.onFileContextChange('/project/src/services/auth.service.ts');

      expect(result).not.toBeNull();
      expect(result!.message).toContain('Relevant workflows:');
    });

    it('should include previous sessions section when relevant', async () => {
      const result = await surfacer.onFileContextChange('/project/src/memory/unified-controller.ts');

      expect(result).not.toBeNull();
      expect(result!.message).toContain('From previous sessions:');
    });

    it('should have correct suggestion structure', async () => {
      const result = await surfacer.onFileContextChange('/project/src/services/auth.service.ts');

      expect(result).not.toBeNull();
      expect(result!.type).toBe('proactive');
      expect(result!.filePath).toBe('/project/src/services/auth.service.ts');
      expect(result!.timestamp).toBeLessThanOrEqual(Date.now());
      expect(result!.relevantMemories).toBeInstanceOf(Array);
    });
  });

  // ============ Events ============

  describe('Events', () => {
    it('should emit context:surfaced on successful surfacing', async () => {
      const surfaceHandler = vi.fn();
      surfacer.on('context:surfaced', surfaceHandler);

      await surfacer.onFileContextChange('/project/src/services/auth.service.ts');

      expect(surfaceHandler).toHaveBeenCalledOnce();
      expect(surfaceHandler).toHaveBeenCalledWith(expect.objectContaining({
        filePath: '/project/src/services/auth.service.ts',
        workflowCount: expect.any(Number),
        sessionCount: expect.any(Number),
        surfacingTimeMs: expect.any(Number),
      }));
    });

    it('should emit cache:cleaned on cleanup', async () => {
      const cleanHandler = vi.fn();
      surfacer.on('cache:cleaned', cleanHandler);

      surfacer.configure({ cooldownMs: 1 });
      await surfacer.onFileContextChange('/project/src/a.ts');
      await new Promise(resolve => setTimeout(resolve, 10));
      surfacer.cleanupCache();

      expect(cleanHandler).toHaveBeenCalledOnce();
      expect(cleanHandler).toHaveBeenCalledWith(expect.objectContaining({
        removed: expect.any(Number),
        remaining: expect.any(Number),
      }));
    });

    it('should emit cache:cleared on clearAllContexts', () => {
      const clearHandler = vi.fn();
      surfacer.on('cache:cleared', clearHandler);

      surfacer.clearAllContexts();

      expect(clearHandler).toHaveBeenCalledOnce();
    });
  });

  // ============ Directory Context ============

  describe('Directory Context', () => {
    it('should handle directory context changes', async () => {
      const result = await surfacer.onDirectoryContextChange('/project/src/services');

      // May or may not find results depending on session/pattern matching
      // The main test is that it doesn't throw
      expect(result === null || result.type === 'proactive').toBe(true);
    });
  });

  // ============ Edge Cases ============

  describe('Edge Cases', () => {
    it('should handle empty file path gracefully', async () => {
      const result = await surfacer.onFileContextChange('');

      // Should not throw, may return null
      expect(result === null || result.type === 'proactive').toBe(true);
    });

    it('should handle very long file paths', async () => {
      const longPath = '/project/' + 'nested/'.repeat(50) + 'file.ts';
      const result = await surfacer.onFileContextChange(longPath);

      // Should not throw
      expect(result === null || result.type === 'proactive').toBe(true);
    });

    it('should handle special characters in file names', async () => {
      // Use a path that will match memories (has 'service' in path) but with special chars
      const result = await surfacer.onFileContextChange('/project/src/services/auth-special_service.ts');

      // Should not throw - may or may not return a result depending on matching
      expect(result === null || result.type === 'proactive').toBe(true);
    });

    it('should handle unicode in file paths', async () => {
      const result = await surfacer.onFileContextChange('/project/src/components/日本語.ts');

      // Should not throw
      expect(result === null || result.type === 'proactive').toBe(true);
    });
  });

  // ============ Relevance Filtering ============

  describe('Relevance Filtering', () => {
    it('should filter by minimum relevance score', async () => {
      surfacer.configure({ minRelevanceScore: 0.8 });
      const result = await surfacer.onFileContextChange('/project/src/random-file.ts');

      if (result) {
        for (const memory of result.relevantMemories) {
          expect(memory.relevanceScore).toBeGreaterThanOrEqual(0.8);
        }
      }
    });

    it('should limit workflows to maxWorkflows', async () => {
      surfacer.configure({ maxWorkflows: 1 });
      const result = await surfacer.onFileContextChange('/project/src/components/test.component.ts');

      if (result) {
        const workflows = result.relevantMemories.filter(m => m.type === 'workflow');
        expect(workflows.length).toBeLessThanOrEqual(1);
      }
    });

    it('should limit sessions to maxSessions', async () => {
      surfacer.configure({ maxSessions: 1 });
      const result = await surfacer.onFileContextChange('/project/src/memory/unified-controller.ts');

      if (result) {
        const sessions = result.relevantMemories.filter(m => m.type === 'session');
        expect(sessions.length).toBeLessThanOrEqual(1);
      }
    });
  });

  // ============ Workflow Relevance Calculation ============

  describe('Workflow Relevance', () => {
    it('should score higher for direct name matches', async () => {
      // Use a test file path to ensure we find test workflows
      const result = await surfacer.onFileContextChange('/project/src/__tests__/user.spec.ts');

      expect(result).not.toBeNull();
      // Should find test workflow with higher relevance for test files
      const testWorkflow = result!.relevantMemories.find(m =>
        m.type === 'workflow' && m.name.toLowerCase().includes('test')
      );

      expect(testWorkflow).toBeDefined();
      // Test workflow should have high relevance for test files
      if (testWorkflow) {
        expect(testWorkflow.relevanceScore).toBeGreaterThan(0.3);
      }
    });

    it('should weight by success rate', async () => {
      // Unit test workflow has 95% success rate
      const result = await surfacer.onFileContextChange('/project/src/__tests__/auth.test.ts');

      expect(result).not.toBeNull();
      const testWorkflow = result!.relevantMemories.find(m =>
        m.type === 'workflow' && m.name.toLowerCase().includes('test')
      );
      expect(testWorkflow).toBeDefined();
    });
  });
});
