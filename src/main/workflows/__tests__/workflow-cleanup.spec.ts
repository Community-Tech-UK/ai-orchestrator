/**
 * WorkflowManager.cleanupInstance Tests
 *
 * Verifies that cleanupInstance correctly removes the instanceExecutions
 * mapping without discarding the execution record itself (history).
 *
 * vi.mock() paths are resolved relative to THIS test file:
 *   src/main/workflows/__tests__/workflow-cleanup.spec.ts
 * So '../../logging/logger' → src/main/logging/logger.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock logger — prevents pulling in Electron or file-system transports
// ---------------------------------------------------------------------------
vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------
import { WorkflowManager, _resetWorkflowManagerForTesting } from '../workflow-manager';

// ---------------------------------------------------------------------------
// Minimal template fixture
// ---------------------------------------------------------------------------
const TEMPLATE_ID = 'test-template';
const INSTANCE_ID = 'instance-abc';

function makeManager(): WorkflowManager {
  const manager = WorkflowManager.getInstance();
  manager.registerTemplate({
    id: TEMPLATE_ID,
    name: 'Test Template',
    description: 'Minimal template for tests',
    phases: [
      {
        id: 'phase-1',
        name: 'Phase 1',
        order: 1,
        description: 'First phase',
        gateType: 'none',
        systemPromptAddition: '',
      },
    ],
  });
  return manager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowManager.cleanupInstance', () => {
  beforeEach(() => {
    _resetWorkflowManagerForTesting();
  });

  it('removes the instanceExecutions mapping for a known instance', () => {
    const manager = makeManager();
    manager.startWorkflow(INSTANCE_ID, TEMPLATE_ID);

    // Before cleanup the instance should map to an active execution
    expect(manager.getExecutionByInstance(INSTANCE_ID)).toBeDefined();

    manager.cleanupInstance(INSTANCE_ID);

    // After cleanup the mapping is gone
    expect(manager.getExecutionByInstance(INSTANCE_ID)).toBeUndefined();
  });

  it('keeps the execution record in history after cleanup', () => {
    const manager = makeManager();
    const execution = manager.startWorkflow(INSTANCE_ID, TEMPLATE_ID);

    manager.cleanupInstance(INSTANCE_ID);

    // The execution itself must still be retrievable by its id
    expect(manager.getExecution(execution.id)).toBeDefined();
    expect(manager.getExecution(execution.id)?.id).toBe(execution.id);
  });

  it('is a no-op for an unknown instance id', () => {
    const manager = makeManager();

    // Should not throw
    expect(() => manager.cleanupInstance('non-existent-instance')).not.toThrow();

    // Global execution list is unaffected (still empty)
    expect(manager.getAllExecutions()).toHaveLength(0);
  });
});
