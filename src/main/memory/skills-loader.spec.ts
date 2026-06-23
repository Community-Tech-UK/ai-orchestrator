/**
 * Skills Loader Tests
 * Phase 2.1 unit tests for embedding-based skill detection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SkillsLoader,
  getSkillsLoader,
  SkillManifestEntry,
  DetectedSkill,
} from './skills-loader';
import type { SkillManifest } from '../../shared/types/skills-manifest.types';

// Mock embedding service
const mockEmbed = vi.fn();
const mockCosineSimilarity = vi.fn();

vi.mock('../rlm/embedding-service', () => ({
  getEmbeddingService: () => ({
    embed: mockEmbed,
    cosineSimilarity: mockCosineSimilarity,
  }),
  EmbeddingService: {
    getInstance: () => ({
      embed: mockEmbed,
      cosineSimilarity: mockCosineSimilarity,
    }),
  },
}));

// Mock skill registry
const mockMatchTrigger = vi.fn();
const mockListSkills = vi.fn();
const mockLoadSkill = vi.fn();
const mockDiscoverSkillsWithBuiltins = vi.fn();

vi.mock('../skills/skill-registry', () => ({
  getSkillRegistry: () => ({
    matchTrigger: mockMatchTrigger,
    listSkills: mockListSkills,
    loadSkill: mockLoadSkill,
    discoverSkillsWithBuiltins: mockDiscoverSkillsWithBuiltins,
  }),
  SkillRegistry: {
    getInstance: () => ({
      matchTrigger: mockMatchTrigger,
      listSkills: mockListSkills,
      loadSkill: mockLoadSkill,
      discoverSkillsWithBuiltins: mockDiscoverSkillsWithBuiltins,
    }),
  },
}));

// Mock fs
const mockReadFile = vi.fn();
vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

describe('SkillsLoader', () => {
  let loader: SkillsLoader;

  // Sample embeddings (384 dimensions like nomic-embed-text)
  const sampleEmbedding = new Array(384).fill(0).map((_, i) => Math.sin(i * 0.1));
  const similarEmbedding = new Array(384).fill(0).map((_, i) => Math.sin(i * 0.1) + 0.01);
  const differentEmbedding = new Array(384).fill(0).map((_, i) => Math.cos(i * 0.5));

  beforeEach(() => {
    vi.clearAllMocks();
    SkillsLoader.resetInstance();
    loader = getSkillsLoader();

    // Default mock implementations
    mockEmbed.mockResolvedValue({
      embedding: sampleEmbedding,
      model: 'nomic-embed-text',
      tokens: 10,
      cached: false,
      provider: 'ollama',
    });

    mockCosineSimilarity.mockImplementation((a: number[], b: number[]) => {
      // Simple similarity based on whether they're the same array reference
      if (a === b) return 1.0;
      // Check if arrays are similar (first elements match)
      if (a[0] === b[0] || Math.abs(a[0] - b[0]) < 0.1) return 0.85;
      return 0.3;
    });

    mockMatchTrigger.mockReturnValue([]);
    mockListSkills.mockReturnValue([]);
    mockLoadSkill.mockResolvedValue({
      coreContent: '# Skill Content',
      tokenEstimate: 100,
    });
    mockDiscoverSkillsWithBuiltins.mockResolvedValue([]);
  });

  afterEach(() => {
    SkillsLoader.resetInstance();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = getSkillsLoader();
      const instance2 = getSkillsLoader();
      expect(instance1).toBe(instance2);
    });

    it('should reset instance correctly', () => {
      const instance1 = getSkillsLoader();
      SkillsLoader.resetInstance();
      const instance2 = getSkillsLoader();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Configuration', () => {
    it('should use default configuration', () => {
      const config = loader.getConfig();
      expect(config.similarityThreshold).toBe(0.65);
      expect(config.maxResults).toBe(3);
      expect(config.cacheEmbeddings).toBe(true);
    });

    it('should allow configuration updates', () => {
      loader.configure({ similarityThreshold: 0.75 });
      const config = loader.getConfig();
      expect(config.similarityThreshold).toBe(0.75);
    });

    it('should preserve other config when updating', () => {
      loader.configure({ similarityThreshold: 0.75 });
      loader.configure({ maxResults: 5 });
      const config = loader.getConfig();
      expect(config.similarityThreshold).toBe(0.75);
      expect(config.maxResults).toBe(5);
    });
  });

  describe('Manifest Loading', () => {
    it('should load skills from manifest file', async () => {
      const manifest: SkillManifest = {
        version: '1.0',
        skills: [
          {
            name: 'angular',
            description: 'Angular framework patterns',
            contentPath: 'angular.md',
            priority: 80,
          },
          {
            name: 'testing',
            description: 'Unit testing strategies',
            contentPath: 'testing.md',
            priority: 70,
          },
        ],
      };

      mockReadFile.mockResolvedValue(JSON.stringify(manifest));

      await loader.loadManifest('/project/.claude/skills/skills.json');

      const skills = loader.listSkills();
      expect(skills).toHaveLength(2);
      expect(skills[0].name).toBe('angular');
      expect(skills[1].name).toBe('testing');
    });

    it('should handle missing manifest gracefully', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      // Should not throw
      await loader.loadManifest('/project/.claude/skills/skills.json');

      const skills = loader.listSkills();
      expect(skills).toHaveLength(0);
    });

    it('should handle invalid JSON gracefully', async () => {
      mockReadFile.mockResolvedValue('invalid json {');

      // Should not throw
      await expect(loader.loadManifest('/project/.claude/skills/skills.json')).resolves.not.toThrow();
    });
  });

  describe('Skill Registration', () => {
    it('should register a skill manually', () => {
      const skill: SkillManifestEntry = {
        name: 'custom',
        description: 'Custom skill',
        contentPath: 'custom.md',
        priority: 50,
      };

      loader.registerSkill(skill);

      const skills = loader.listSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('custom');
    });

    it('should unregister a skill', () => {
      loader.registerSkill({
        name: 'temp',
        description: 'Temporary',
        contentPath: 'temp.md',
        priority: 50,
      });

      expect(loader.listSkills()).toHaveLength(1);

      const removed = loader.unregisterSkill('temp');
      expect(removed).toBe(true);
      expect(loader.listSkills()).toHaveLength(0);
    });

    it('should return false when unregistering non-existent skill', () => {
      const removed = loader.unregisterSkill('nonexistent');
      expect(removed).toBe(false);
    });

    it('should get skill by name', () => {
      loader.registerSkill({
        name: 'angular',
        description: 'Angular patterns',
        contentPath: 'angular.md',
        priority: 80,
      });

      const skill = loader.getSkill('angular');
      expect(skill).toBeDefined();
      expect(skill?.description).toBe('Angular patterns');
    });
  });

  describe('Skill Detection', () => {
    beforeEach(async () => {
      // Register some test skills
      loader.registerSkill({
        name: 'angular',
        description: 'Angular component development and patterns',
        contentPath: 'angular.md',
        priority: 80,
      });
      loader.registerSkill({
        name: 'testing',
        description: 'Unit testing with Jasmine and Jest',
        contentPath: 'testing.md',
        priority: 70,
      });
      loader.registerSkill({
        name: 'debugging',
        description: 'Debugging TypeScript applications',
        contentPath: 'debugging.md',
        priority: 60,
      });

      // Simulate pre-computed embeddings by waiting for the async registration
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it('should detect relevant skills based on embedding similarity', async () => {
      // Mock high similarity for first skill
      mockCosineSimilarity.mockImplementation((a: number[], b: number[]) => 0.8);

      const detected = await loader.detectRelevantSkills('How do I create an Angular component?');

      expect(detected.length).toBeGreaterThan(0);
      expect(detected.every((s) => s.similarity >= 0.65)).toBe(true);
    });

    it('should limit results to maxResults', async () => {
      loader.configure({ maxResults: 2 });
      mockCosineSimilarity.mockReturnValue(0.9);

      const detected = await loader.detectRelevantSkills('How do I test Angular components?');

      expect(detected.length).toBeLessThanOrEqual(2);
    });

    it('should filter out skills below threshold', async () => {
      mockCosineSimilarity.mockReturnValue(0.4); // Below 0.65 threshold

      const detected = await loader.detectRelevantSkills('Unrelated query about cooking');

      expect(detected).toHaveLength(0);
    });

    it('should sort by similarity then priority', async () => {
      // First call for user message, then for comparisons
      let callCount = 0;
      mockCosineSimilarity.mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return 0.75; // All similar
        return 0.75;
      });

      const detected = await loader.detectRelevantSkills('How do I test?');

      if (detected.length > 1) {
        // Skills should be sorted by similarity (then priority as tiebreaker)
        for (let i = 0; i < detected.length - 1; i++) {
          const current = detected[i];
          const next = detected[i + 1];
          // If similarity is close, priority should be higher or equal
          if (Math.abs(current.similarity - next.similarity) <= 0.05) {
            expect(current.priority).toBeGreaterThanOrEqual(next.priority);
          }
        }
      }
    });

    it('should include trigger matches from registry', async () => {
      mockMatchTrigger.mockReturnValue([
        {
          skill: {
            id: 'skill-angular',
            metadata: { name: 'angular', description: 'Angular patterns', triggers: ['ng'] },
            corePath: 'angular.md',
          },
          trigger: 'ng',
          confidence: 0.9,
        },
      ]);
      mockCosineSimilarity.mockReturnValue(0.7);

      const detected = await loader.detectRelevantSkills('How do I use ng generate?');

      expect(detected.some((s) => s.name === 'angular')).toBe(true);
    });

    it('should discover built-in trigger skills and keep exact matches when embeddings fail', async () => {
      const publicWritingSkill = {
        id: 'skill-human-public-writing',
        metadata: {
          name: 'human-public-writing',
          description: 'Use when writing public-facing prose or when the user says use my tone.',
          triggers: ['use my tone'],
        },
        corePath: 'human-public-writing/SKILL.md',
      };
      let discovered = false;

      mockDiscoverSkillsWithBuiltins.mockImplementation(async () => {
        discovered = true;
        return [publicWritingSkill];
      });
      mockListSkills.mockImplementation(() => discovered ? [publicWritingSkill] : []);
      mockMatchTrigger.mockReturnValue([
        {
          skill: publicWritingSkill,
          trigger: 'use my tone',
          confidence: 1,
        },
      ]);
      mockEmbed.mockRejectedValue(new Error('Embedding service offline'));

      const detected = await loader.detectRelevantSkills('use my tone');

      expect(mockDiscoverSkillsWithBuiltins).toHaveBeenCalled();
      expect(detected[0]).toMatchObject({
        name: 'human-public-writing',
        source: 'trigger',
        similarity: 1,
      });
    });

    it('should mark source correctly for embedding-only matches', async () => {
      mockMatchTrigger.mockReturnValue([]);
      mockCosineSimilarity.mockReturnValue(0.8);

      const detected = await loader.detectRelevantSkills('Build a form with validation');

      if (detected.length > 0) {
        expect(detected[0].source).toBe('embedding');
      }
    });

    it('should update detection stats', async () => {
      mockCosineSimilarity.mockReturnValue(0.8);

      const statsBefore = loader.getStats();
      expect(statsBefore.detectionCount).toBe(0);

      await loader.detectRelevantSkills('Test query');

      const statsAfter = loader.getStats();
      expect(statsAfter.detectionCount).toBe(1);
      // Detection time can be 0ms when tests run very fast
      expect(statsAfter.lastDetectionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Skill Content Loading', () => {
    beforeEach(() => {
      loader.registerSkill({
        name: 'angular',
        description: 'Angular patterns',
        contentPath: '/project/.claude/skills/angular.md',
        priority: 80,
      });
    });

    it('should load skill content from file', async () => {
      const content = '# Angular Guide\n\nBest practices...';
      mockReadFile.mockResolvedValue(content);
      mockListSkills.mockReturnValue([]); // Not in registry

      const skill: DetectedSkill = {
        name: 'angular',
        description: 'Angular patterns',
        contentPath: '/project/.claude/skills/angular.md',
        priority: 80,
        similarity: 0.9,
        source: 'embedding',
      };

      const loaded = await loader.loadSkillContent(skill);

      expect(loaded).toBe(content);
    });

    it('should use registry loader when skill is registered there', async () => {
      mockListSkills.mockReturnValue([
        {
          id: 'skill-angular',
          metadata: { name: 'angular', description: 'Angular patterns', triggers: [] },
          corePath: 'angular.md',
        },
      ]);

      mockLoadSkill.mockResolvedValue({
        coreContent: '# Angular from Registry',
        tokenEstimate: 200,
      });

      const skill: DetectedSkill = {
        name: 'angular',
        description: 'Angular patterns',
        contentPath: '/project/.claude/skills/angular.md',
        priority: 80,
        similarity: 0.9,
        source: 'both',
      };

      const loaded = await loader.loadSkillContent(skill);

      expect(loaded).toBe('# Angular from Registry');
      expect(mockLoadSkill).toHaveBeenCalled();
    });

    it('should return null for failed loads', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      mockListSkills.mockReturnValue([]);

      const skill: DetectedSkill = {
        name: 'missing',
        description: 'Missing skill',
        contentPath: '/nonexistent/path.md',
        priority: 50,
        similarity: 0.8,
        source: 'embedding',
      };

      const loaded = await loader.loadSkillContent(skill);

      expect(loaded).toBeNull();
    });
  });

  describe('Budget-aware Loading', () => {
    beforeEach(() => {
      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('small')) return 'Short content';
        if (path.includes('medium')) return 'x'.repeat(2000); // ~500 tokens
        if (path.includes('large')) return 'x'.repeat(20000); // ~5000 tokens
        return 'Default content';
      });
      mockListSkills.mockReturnValue([]);
    });

    it('should load skills within token budget', async () => {
      const skills: DetectedSkill[] = [
        {
          name: 'small',
          description: 'Small skill',
          contentPath: '/skills/small.md',
          priority: 80,
          similarity: 0.9,
          source: 'embedding',
        },
        {
          name: 'medium',
          description: 'Medium skill',
          contentPath: '/skills/medium.md',
          priority: 70,
          similarity: 0.8,
          source: 'embedding',
        },
      ];

      const result = await loader.loadSkillsWithBudget(skills, 1000);

      expect(result.loaded.length).toBeGreaterThan(0);
      expect(result.totalTokens).toBeLessThanOrEqual(1000);
    });

    it('should prioritize high-priority skills when budget is limited', async () => {
      const skills: DetectedSkill[] = [
        {
          name: 'low-priority',
          description: 'Low priority skill',
          contentPath: '/skills/medium.md',
          priority: 30,
          similarity: 0.9,
          source: 'embedding',
        },
        {
          name: 'high-priority',
          description: 'High priority skill',
          contentPath: '/skills/small.md',
          priority: 90,
          similarity: 0.8,
          source: 'embedding',
        },
      ];

      // Very small budget - should only fit one skill
      const result = await loader.loadSkillsWithBudget(skills, 100);

      expect(result.loaded).toContain('high-priority');
    });

    it('should return empty arrays when budget is zero', async () => {
      const skills: DetectedSkill[] = [
        {
          name: 'any',
          description: 'Any skill',
          contentPath: '/skills/small.md',
          priority: 50,
          similarity: 0.8,
          source: 'embedding',
        },
      ];

      const result = await loader.loadSkillsWithBudget(skills, 0);

      expect(result.content).toHaveLength(0);
      expect(result.loaded).toHaveLength(0);
      expect(result.totalTokens).toBe(0);
    });
  });

  describe('Statistics', () => {
    it('should track total skills count', () => {
      loader.registerSkill({
        name: 'skill1',
        description: 'First skill',
        contentPath: 'skill1.md',
        priority: 50,
      });
      loader.registerSkill({
        name: 'skill2',
        description: 'Second skill',
        contentPath: 'skill2.md',
        priority: 50,
      });

      const stats = loader.getStats();
      expect(stats.totalSkills).toBe(2);
    });

    it('should track detection metrics', async () => {
      loader.registerSkill({
        name: 'test',
        description: 'Test skill',
        contentPath: 'test.md',
        priority: 50,
      });

      mockCosineSimilarity.mockReturnValue(0.8);

      await loader.detectRelevantSkills('Query 1');
      await loader.detectRelevantSkills('Query 2');

      const stats = loader.getStats();
      expect(stats.detectionCount).toBe(2);
      // Average detection time can be 0ms when tests run very fast
      expect(stats.avgDetectionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should reset stats on clear', () => {
      loader.registerSkill({
        name: 'test',
        description: 'Test',
        contentPath: 'test.md',
        priority: 50,
      });

      loader.clear();

      const stats = loader.getStats();
      expect(stats.totalSkills).toBe(0);
      expect(stats.detectionCount).toBe(0);
    });
  });

  describe('Cleanup', () => {
    it('should clear all data', () => {
      loader.registerSkill({
        name: 'test',
        description: 'Test',
        contentPath: 'test.md',
        priority: 50,
      });

      expect(loader.listSkills()).toHaveLength(1);

      loader.clear();

      expect(loader.listSkills()).toHaveLength(0);
      expect(loader.getStats().totalSkills).toBe(0);
    });
  });

  describe('Event Emission', () => {
    it('should emit skills:detected event', async () => {
      const eventHandler = vi.fn();
      loader.on('skills:detected', eventHandler);

      loader.registerSkill({
        name: 'test',
        description: 'Test',
        contentPath: 'test.md',
        priority: 50,
      });

      mockCosineSimilarity.mockReturnValue(0.8);

      await loader.detectRelevantSkills('Test query');

      expect(eventHandler).toHaveBeenCalled();
      expect(eventHandler.mock.calls[0][0]).toHaveProperty('query');
      expect(eventHandler.mock.calls[0][0]).toHaveProperty('results');
    });

    it('should emit skill:registered event', () => {
      const eventHandler = vi.fn();
      loader.on('skill:registered', eventHandler);

      loader.registerSkill({
        name: 'test',
        description: 'Test',
        contentPath: 'test.md',
        priority: 50,
      });

      expect(eventHandler).toHaveBeenCalledWith({ skill: 'test' });
    });

    it('should emit skill:unregistered event', () => {
      const eventHandler = vi.fn();
      loader.on('skill:unregistered', eventHandler);

      loader.registerSkill({
        name: 'test',
        description: 'Test',
        contentPath: 'test.md',
        priority: 50,
      });

      loader.unregisterSkill('test');

      expect(eventHandler).toHaveBeenCalledWith({ skill: 'test' });
    });
  });
});
