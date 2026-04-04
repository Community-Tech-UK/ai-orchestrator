import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowPersistence } from '../workflow-persistence.js';
import type { WorkflowExecution } from '../../../shared/types/workflow.types.js';

describe('WorkflowPersistence', () => {
  let persistence: WorkflowPersistence;
  let mockRun: ReturnType<typeof vi.fn>;
  let mockAll: ReturnType<typeof vi.fn>;
  let mockGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRun = vi.fn();
    mockAll = vi.fn().mockReturnValue([]);
    mockGet = vi.fn().mockReturnValue(undefined);
    const mockDb = {
      prepare: vi.fn().mockReturnValue({ run: mockRun, all: mockAll, get: mockGet }),
    };
    persistence = new WorkflowPersistence(mockDb as never);
  });

  it('should save a workflow execution', () => {
    const execution: WorkflowExecution = {
      id: 'exec-1',
      instanceId: 'inst-1',
      templateId: 'tmpl-1',
      currentPhaseId: 'phase-1',
      phaseStatuses: { 'phase-1': 'active' },
      phaseData: {},
      startedAt: 1712200000000,
      agentInvocations: 0,
      totalTokens: 0,
      totalCost: 0,
    };

    persistence.save(execution);
    expect(mockRun).toHaveBeenCalledWith(
      'exec-1',      // id
      'inst-1',      // instance_id
      'tmpl-1',      // template_id
      'active',      // status
      'phase-1',     // current_phase_id
      expect.any(String), // phase_statuses_json
      expect.any(String), // phase_data_json
      null,          // pending_gate_json (no pending gate)
      1712200000000, // started_at
      null,          // completed_at
      0,             // agent_invocations
      0,             // total_tokens
      0,             // total_cost
    );
  });

  it('should load active executions', () => {
    persistence.loadActive();
    expect(mockAll).toHaveBeenCalled();
  });

  it('should load by id', () => {
    persistence.loadById('exec-1');
    expect(mockGet).toHaveBeenCalledWith('exec-1');
  });
});
