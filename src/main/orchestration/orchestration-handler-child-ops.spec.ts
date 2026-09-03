import { describe, expect, it, vi } from 'vitest';
import {
  handleGetChildSummary,
  handleReportTaskComplete,
  type OrchestrationChildOpsHost,
} from './orchestration-handler-child-ops';
import type { OrchestrationContext } from './orchestration-handler.types';

const completeTask = vi.fn();
const getTaskByChildId = vi.fn();

vi.mock('./task-manager', () => ({
  getTaskManager: () => ({
    getTaskByChildId,
    completeTask,
    updateProgress: vi.fn(),
    failTask: vi.fn(),
    getTask: vi.fn(),
    getTasksByParentId: vi.fn(() => []),
    serializeTask: vi.fn((task: { taskId: string }) => task),
    getTaskHistory: vi.fn(() => []),
  }),
}));

function host(overrides: Partial<OrchestrationChildOpsHost> = {}): OrchestrationChildOpsHost {
  const contexts = new Map<string, OrchestrationContext>([
    ['child-1', {
      instanceId: 'child-1',
      workingDirectory: '/tmp',
      parentId: 'parent-1',
      childrenIds: [],
    }],
    ['parent-1', {
      instanceId: 'parent-1',
      workingDirectory: '/tmp',
      parentId: null,
      childrenIds: ['child-1'],
    }],
  ]);
  return {
    getContext: (id) => contexts.get(id),
    isChildOfParent: (parentId, childId) => parentId === 'parent-1' && childId === 'child-1',
    injectResponse: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  };
}

describe('orchestration-handler-child-ops', () => {
  it('ignores a completion report when the child has no parent', () => {
    const ops = host({
      getContext: () => ({
        instanceId: 'orphan',
        workingDirectory: '/tmp',
        parentId: null,
        childrenIds: [],
      }),
    });
    handleReportTaskComplete(ops, 'orphan', {
      action: 'report_task_complete',
      success: true,
      summary: 'done',
    });
    expect(ops.injectResponse).not.toHaveBeenCalled();
  });

  it('rejects get_child_summary for a child the parent does not own', () => {
    const ops = host();
    handleGetChildSummary(ops, 'parent-1', {
      action: 'get_child_summary',
      childId: 'stranger',
    });
    expect(ops.injectResponse).toHaveBeenCalledWith(
      'parent-1',
      'get_child_summary',
      false,
      { error: 'Child stranger not found or not owned by you' },
    );
    expect(ops.emit).not.toHaveBeenCalled();
  });

  it('notifies the parent when a child reports completion', () => {
    getTaskByChildId.mockReturnValue({ taskId: 'task-1' });
    const ops = host();
    handleReportTaskComplete(ops, 'child-1', {
      action: 'report_task_complete',
      success: true,
      summary: 'finished the probe',
    });
    expect(completeTask).toHaveBeenCalled();
    expect(ops.injectResponse).toHaveBeenCalledWith(
      'parent-1',
      'task_complete',
      true,
      expect.objectContaining({
        childId: 'child-1',
        taskId: 'task-1',
      }),
    );
  });
});
