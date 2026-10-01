/**
 * Procedural Store Tests
 * Phase 4 unit tests for failure analysis and workflow versioning
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProceduralStore, getProceduralStore } from './procedural-store';
import type {
  WorkflowMemory,
  WorkflowOutcome,
} from '../../shared/types/unified-memory.types';

describe('ProceduralStore', () => {
  let store: ProceduralStore;

  beforeEach(() => {
    vi.clearAllMocks();
    ProceduralStore.resetInstance();
    store = getProceduralStore();
  });

  afterEach(() => {
    ProceduralStore.resetInstance();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance', () => {
      const instance1 = getProceduralStore();
      const instance2 = getProceduralStore();
      expect(instance1).toBe(instance2);
    });

    it('should allow reset for testing', () => {
      const instance1 = getProceduralStore();
      ProceduralStore.resetInstance();
      const instance2 = getProceduralStore();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Basic Workflow Management', () => {
    it('should add a new workflow', () => {
      const workflow: WorkflowMemory = {
        id: 'wf-1',
        name: 'Test Workflow',
        steps: ['Step 1', 'Step 2'],
        successRate: 0.8,
        applicableContexts: ['testing'],
      };

      store.addWorkflow(workflow);

      const retrieved = store.getWorkflow('wf-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Test Workflow');
    });

    it('should update existing workflow by name', () => {
      const workflow1: WorkflowMemory = {
        id: 'wf-1',
        name: 'Test Workflow',
        steps: ['Step 1'],
        successRate: 0.7,
        applicableContexts: ['context1'],
      };

      const workflow2: WorkflowMemory = {
        id: 'wf-2',
        name: 'Test Workflow',
        steps: ['Step 1', 'Step 2'],
        successRate: 0.8,
        applicableContexts: ['context2'],
      };

      store.addWorkflow(workflow1);
      store.addWorkflow(workflow2);

      const retrieved = store.getWorkflow('wf-1');
      expect(retrieved?.steps).toEqual(['Step 1', 'Step 2']);
      expect(retrieved?.applicableContexts).toContain('context1');
      expect(retrieved?.applicableContexts).toContain('context2');
    });
  });

  // ============ Phase 4.1: Failure Analysis Tests ============

  describe('Failure Analysis', () => {
    let workflow: WorkflowMemory;

    beforeEach(() => {
      workflow = {
        id: 'wf-fail-1',
        name: 'Failure Test Workflow',
        steps: ['Step 1', 'Step 2'],
        successRate: 1.0,
        applicableContexts: ['testing'],
      };
      store.addWorkflow(workflow);
    });

    describe('recordWorkflowUsage with failure tracking', () => {
      it('should track successful usage (boolean overload)', () => {
        store.recordWorkflowUsage('wf-fail-1', true);

        const retrieved = store.getWorkflow('wf-fail-1');
        expect(retrieved?.outcomes).toBeDefined();
        expect(retrieved?.outcomes?.length).toBe(1);
        expect(retrieved?.outcomes?.[0].success).toBe(true);
      });

      it('should track failed usage with outcome details', () => {
        const outcome: WorkflowOutcome = {
          taskId: 'task-1',
          success: false,
          score: 0.2,
          timestamp: Date.now(),
          failureReason: 'error',
          errorPattern: 'TypeError: undefined is not a function',
          userFeedback: 'Need to check for null',
        };

        store.recordWorkflowUsage('wf-fail-1', outcome);

        const retrieved = store.getWorkflow('wf-fail-1');
        expect(retrieved?.outcomes).toBeDefined();
        expect(retrieved?.outcomes?.[0].failureReason).toBe('error');
        expect(retrieved?.outcomes?.[0].errorPattern).toContain('TypeError');
      });

      it('should track failure patterns', () => {
        const outcome: WorkflowOutcome = {
          taskId: 'task-1',
          success: false,
          score: 0,
          timestamp: Date.now(),
          failureReason: 'user_correction',
          errorPattern: 'wrong approach',
        };

        store.recordWorkflowUsage('wf-fail-1', outcome);

        const retrieved = store.getWorkflow('wf-fail-1');
        expect(retrieved?.failurePatterns).toBeDefined();
        expect(retrieved?.failurePatterns?.length).toBe(1);
        expect(retrieved?.failurePatterns?.[0].reason).toBe('user_correction');
      });

      it('should update success rate on failure', () => {
        store.recordWorkflowUsage('wf-fail-1', false);

        const retrieved = store.getWorkflow('wf-fail-1');
        expect(retrieved?.successRate).toBeLessThan(1.0);
      });

      it('should emit failure tracked event', () => {
        const listener = vi.fn();
        store.on('workflow:failureTracked', listener);

        const outcome: WorkflowOutcome = {
          taskId: 'task-1',
          success: false,
          score: 0,
          timestamp: Date.now(),
          failureReason: 'timeout',
          errorPattern: 'timeout after 30s',
        };

        store.recordWorkflowUsage('wf-fail-1', outcome);

        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({
            workflowId: 'wf-fail-1',
            pattern: expect.objectContaining({
              reason: 'timeout',
            }),
          })
        );
      });
    });

    describe('Avoidance Rules', () => {
      it('should create avoidance rule after repeated failures', () => {
        const errorPattern = 'Connection refused to database';

        // Record 3 failures with same pattern (threshold is 3)
        for (let i = 0; i < 3; i++) {
          const outcome: WorkflowOutcome = {
            taskId: `task-${i}`,
            success: false,
            score: 0,
            timestamp: Date.now() + i,
            failureReason: 'error',
            errorPattern,
          };
          store.recordWorkflowUsage('wf-fail-1', outcome);
        }

        const rules = store.getAvoidanceRules('wf-fail-1');
        expect(rules.length).toBe(1);
        expect(rules[0].errorPattern).toBe(errorPattern);
      });

      it('should not create avoidance rule before threshold', () => {
        const errorPattern = 'Some error';

        // Record only 2 failures (below threshold of 3)
        for (let i = 0; i < 2; i++) {
          const outcome: WorkflowOutcome = {
            taskId: `task-${i}`,
            success: false,
            score: 0,
            timestamp: Date.now() + i,
            failureReason: 'error',
            errorPattern,
          };
          store.recordWorkflowUsage('wf-fail-1', outcome);
        }

        const rules = store.getAvoidanceRules('wf-fail-1');
        expect(rules.length).toBe(0);
      });

      it('should update existing avoidance rule on repeat', () => {
        const errorPattern = 'Repeated error pattern';

        // Create initial rule (3 failures)
        for (let i = 0; i < 3; i++) {
          const outcome: WorkflowOutcome = {
            taskId: `task-${i}`,
            success: false,
            score: 0,
            timestamp: Date.now() + i,
            failureReason: 'error',
            errorPattern,
          };
          store.recordWorkflowUsage('wf-fail-1', outcome);
        }

        const rulesBefore = store.getAvoidanceRules('wf-fail-1');
        expect(rulesBefore[0].occurrenceCount).toBe(3);

        // Add more failures
        for (let i = 3; i < 6; i++) {
          const outcome: WorkflowOutcome = {
            taskId: `task-${i}`,
            success: false,
            score: 0,
            timestamp: Date.now() + i,
            failureReason: 'error',
            errorPattern,
          };
          store.recordWorkflowUsage('wf-fail-1', outcome);
        }

        const rulesAfter = store.getAvoidanceRules('wf-fail-1');
        expect(rulesAfter.length).toBe(1); // Still one rule
        expect(rulesAfter[0].occurrenceCount).toBeGreaterThan(3);
      });

      it('should check if error pattern should be avoided', () => {
        const errorPattern = 'SSL certificate error';

        // Create avoidance rule
        for (let i = 0; i < 3; i++) {
          const outcome: WorkflowOutcome = {
            taskId: `task-${i}`,
            success: false,
            score: 0,
            timestamp: Date.now() + i,
            failureReason: 'error',
            errorPattern,
          };
          store.recordWorkflowUsage('wf-fail-1', outcome);
        }

        const rule = store.shouldAvoid('wf-fail-1', 'connecting with ssl certificate error');
        expect(rule).not.toBeNull();
        expect(rule?.errorPattern).toBe(errorPattern);
      });

      it('should return null for unmatched patterns', () => {
        const rule = store.shouldAvoid('wf-fail-1', 'some random context');
        expect(rule).toBeNull();
      });

      it('should persist avoidance rules in export', () => {
        store.createAvoidanceRule('wf-fail-1', 'test error', 'avoid this');

        const exported = store.exportState();
        expect(exported.avoidanceRules.length).toBe(1);
        expect(exported.avoidanceRules[0].errorPattern).toBe('test error');
      });

      it('should restore avoidance rules on import', () => {
        const state = {
          workflows: [],
          strategies: [],
          avoidanceRules: [
            {
              id: 'avoid-1',
              workflowId: 'wf-1',
              errorPattern: 'imported error',
              avoidanceStrategy: 'avoid it',
              learnedAt: Date.now(),
              occurrenceCount: 5,
            },
          ],
        };

        store.importState(state);

        const rules = store.getAvoidanceRules('wf-1');
        expect(rules.length).toBe(1);
        expect(rules[0].errorPattern).toBe('imported error');
      });
    });
  });

  // ============ Phase 4.2: Workflow Versioning Tests ============

  describe('Workflow Versioning', () => {
    let workflow: WorkflowMemory;

    beforeEach(() => {
      workflow = {
        id: 'wf-version-1',
        name: 'Versioned Workflow',
        steps: ['Initial Step 1', 'Initial Step 2'],
        successRate: 0.8,
        applicableContexts: ['testing'],
      };
      store.addWorkflow(workflow);
    });

    describe('Initial Version', () => {
      it('should create initial version when adding workflow', () => {
        const retrieved = store.getWorkflow('wf-version-1');
        expect(retrieved?.versions).toBeDefined();
        expect(retrieved?.versions?.length).toBe(1);
        expect(retrieved?.versions?.[0].version).toBe(1);
        expect(retrieved?.versions?.[0].reason).toBe('initial');
      });

      it('should set currentVersion to 1', () => {
        const retrieved = store.getWorkflow('wf-version-1');
        expect(retrieved?.currentVersion).toBe(1);
      });

      it('should preserve steps in initial version', () => {
        const retrieved = store.getWorkflow('wf-version-1');
        expect(retrieved?.versions?.[0].steps).toEqual(['Initial Step 1', 'Initial Step 2']);
      });
    });

    describe('updateWorkflow', () => {
      it('should create new version on update', () => {
        const newSteps = ['Updated Step 1', 'Updated Step 2', 'Updated Step 3'];
        store.updateWorkflow('wf-version-1', newSteps, 'improvement');

        const retrieved = store.getWorkflow('wf-version-1');
        expect(retrieved?.versions?.length).toBe(2);
        expect(retrieved?.currentVersion).toBe(2);
      });

      it('should preserve parent version reference', () => {
        store.updateWorkflow('wf-version-1', ['New Step'], 'error_fix');

        const retrieved = store.getWorkflow('wf-version-1');
        expect(retrieved?.versions?.[1].parentVersion).toBe(1);
      });

      it('should update workflow steps to new version', () => {
        const newSteps = ['Completely New Step'];
        store.updateWorkflow('wf-version-1', newSteps, 'user_update');

        const retrieved = store.getWorkflow('wf-version-1');
        expect(retrieved?.steps).toEqual(['Completely New Step']);
      });

      it('should track version reason', () => {
        store.updateWorkflow('wf-version-1', ['Step'], 'error_fix');

        const retrieved = store.getWorkflow('wf-version-1');
        expect(retrieved?.versions?.[1].reason).toBe('error_fix');
      });

      it('should emit version created event', () => {
        const listener = vi.fn();
        store.on('workflow:versionCreated', listener);

        store.updateWorkflow('wf-version-1', ['New Step'], 'improvement');

        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({
            workflowId: 'wf-version-1',
            version: expect.objectContaining({ version: 2 }),
          })
        );
      });

      it('should limit versions to maxVersionsPerWorkflow', () => {
        // Configure to keep only 3 versions
        store.configure({ maxVersionsPerWorkflow: 3 });

        // Create 5 versions total (initial + 4 updates)
        for (let i = 0; i < 4; i++) {
          store.updateWorkflow('wf-version-1', [`Step v${i + 2}`], 'improvement');
        }

        const retrieved = store.getWorkflow('wf-version-1');
        expect(retrieved?.versions?.length).toBe(3);
      });

      it('should return null for non-existent workflow', () => {
        const result = store.updateWorkflow('non-existent', ['Step'], 'improvement');
        expect(result).toBeNull();
      });
    });

    describe('rollbackWorkflow', () => {
      beforeEach(() => {
        // Create multiple versions
        store.updateWorkflow('wf-version-1', ['V2 Step'], 'improvement');
        store.updateWorkflow('wf-version-1', ['V3 Step'], 'improvement');
      });

      it('should rollback to previous version by default', () => {
        store.rollbackWorkflow('wf-version-1');

        const retrieved = store.getWorkflow('wf-version-1');
        expect(retrieved?.currentVersion).toBe(2);
        expect(retrieved?.steps).toEqual(['V2 Step']);
      });

      it('should rollback to specific version', () => {
        store.rollbackWorkflow('wf-version-1', 1);

        const retrieved = store.getWorkflow('wf-version-1');
        expect(retrieved?.currentVersion).toBe(1);
        expect(retrieved?.steps).toEqual(['Initial Step 1', 'Initial Step 2']);
      });

      it('should emit rollback event', () => {
        const listener = vi.fn();
        store.on('workflow:rolledBack', listener);

        store.rollbackWorkflow('wf-version-1');

        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({
            workflowId: 'wf-version-1',
            fromVersion: 3,
            toVersion: 2,
          })
        );
      });

      it('should return null for workflow without versions', () => {
        // Create a workflow without going through addWorkflow
        const noVersionWorkflow: WorkflowMemory = {
          id: 'wf-no-version',
          name: 'No Version',
          steps: ['Step'],
          successRate: 0.5,
          applicableContexts: [],
        };
        // Directly add to bypass versioning (simulate legacy data)
        (store as unknown as { workflows: WorkflowMemory[] }).workflows.push(noVersionWorkflow);

        const result = store.rollbackWorkflow('wf-no-version');
        expect(result).toBeNull();
      });

      it('should return null for non-existent target version', () => {
        const result = store.rollbackWorkflow('wf-version-1', 99);
        expect(result).toBeNull();
      });
    });

    describe('getWorkflowVersions', () => {
      it('should return version history', () => {
        store.updateWorkflow('wf-version-1', ['V2'], 'improvement');

        const versions = store.getWorkflowVersions('wf-version-1');
        expect(versions.length).toBe(2);
        expect(versions[0].version).toBe(1);
        expect(versions[1].version).toBe(2);
      });

      it('should return empty array for non-existent workflow', () => {
        const versions = store.getWorkflowVersions('non-existent');
        expect(versions).toEqual([]);
      });
    });

    describe('getWorkflowVersion', () => {
      it('should return specific version', () => {
        store.updateWorkflow('wf-version-1', ['V2 Step'], 'improvement');

        const version = store.getWorkflowVersion('wf-version-1', 1);
        expect(version).not.toBeNull();
        expect(version?.steps).toEqual(['Initial Step 1', 'Initial Step 2']);
      });

      it('should return null for non-existent version', () => {
        const version = store.getWorkflowVersion('wf-version-1', 99);
        expect(version).toBeNull();
      });
    });
  });

  // ============ Statistics Tests ============

  describe('Statistics', () => {
    it('should include avoidance rules count', () => {
      store.createAvoidanceRule('wf-1', 'error1', 'avoid1');
      store.createAvoidanceRule('wf-2', 'error2', 'avoid2');

      const stats = store.getStats();
      expect(stats.totalAvoidanceRules).toBe(2);
    });

    it('should count workflows with versions', () => {
      const workflow1: WorkflowMemory = {
        id: 'wf-1',
        name: 'Workflow 1',
        steps: ['Step'],
        successRate: 0.8,
        applicableContexts: [],
      };
      const workflow2: WorkflowMemory = {
        id: 'wf-2',
        name: 'Workflow 2',
        steps: ['Step'],
        successRate: 0.7,
        applicableContexts: [],
      };

      store.addWorkflow(workflow1);
      store.addWorkflow(workflow2);

      // Update only workflow1 to create multiple versions
      store.updateWorkflow('wf-1', ['New Step'], 'improvement');

      const stats = store.getStats();
      expect(stats.workflowsWithVersions).toBe(1);
    });
  });

  // ============ Persistence Tests ============

  describe('Persistence', () => {
    it('should export complete state', () => {
      const workflow: WorkflowMemory = {
        id: 'wf-1',
        name: 'Test',
        steps: ['Step'],
        successRate: 0.8,
        applicableContexts: [],
      };
      store.addWorkflow(workflow);
      store.createAvoidanceRule('wf-1', 'error', 'avoid');

      const state = store.exportState();
      expect(state.workflows.length).toBe(1);
      expect(state.avoidanceRules.length).toBe(1);
    });

    it('should clear all data including avoidance rules', () => {
      store.addWorkflow({
        id: 'wf-1',
        name: 'Test',
        steps: ['Step'],
        successRate: 0.8,
        applicableContexts: [],
      });
      store.createAvoidanceRule('wf-1', 'error', 'avoid');

      store.clear();

      const stats = store.getStats();
      expect(stats.totalWorkflows).toBe(0);
      expect(stats.totalAvoidanceRules).toBe(0);
    });
  });
});
