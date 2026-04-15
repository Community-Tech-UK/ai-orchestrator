/**
 * PlanModeManager — Manages plan mode state transitions for instances.
 *
 * Extracted from instance-lifecycle.ts to reduce its size and isolate
 * the plan-mode state machine (off → planning → approved → off).
 *
 * Not a singleton — accepts dependencies via constructor injection.
 */

import type { EventEmitter } from 'events';
import type { Instance } from '../../../shared/types/instance.types';
import { getLogger } from '../../logging/logger';

const logger = getLogger('PlanModeManager');

export interface PlanModeDeps {
  /** Resolve an instance by ID. Returns undefined if not found. */
  getInstance: (id: string) => Instance | undefined;
}

export class PlanModeManager {
  constructor(
    private readonly deps: PlanModeDeps,
    private readonly emitter: EventEmitter,
  ) {}

  /**
   * Enter plan mode for an instance.
   * Transitions: off → planning
   */
  enterPlanMode(instanceId: string): Instance {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    instance.planMode = {
      enabled: true,
      state: 'planning',
      planContent: undefined,
      approvedAt: undefined,
    };

    this.emitter.emit('state-update', {
      instanceId,
      status: instance.status,
      planMode: instance.planMode,
    });

    logger.info('Entered plan mode', { instanceId });
    return instance;
  }

  /**
   * Exit plan mode.
   * Transitions: approved → off (or any → off if force=true)
   */
  exitPlanMode(instanceId: string, force = false): Instance {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (!instance.planMode.enabled) {
      throw new Error('Instance is not in plan mode');
    }

    if (!force && instance.planMode.state !== 'approved') {
      throw new Error('Plan must be approved before exiting plan mode');
    }

    instance.planMode = {
      enabled: false,
      state: 'off',
      planContent: undefined,
      approvedAt: undefined,
    };

    this.emitter.emit('state-update', {
      instanceId,
      status: instance.status,
      planMode: instance.planMode,
    });

    logger.info('Exited plan mode', { instanceId });
    return instance;
  }

  /**
   * Approve a plan in plan mode.
   * Transitions: planning → approved
   */
  approvePlan(instanceId: string, planContent?: string): Instance {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (!instance.planMode.enabled) {
      throw new Error('Instance is not in plan mode');
    }

    instance.planMode = {
      enabled: true,
      state: 'approved',
      planContent: planContent || instance.planMode.planContent,
      approvedAt: Date.now(),
    };

    this.emitter.emit('state-update', {
      instanceId,
      status: instance.status,
      planMode: instance.planMode,
    });

    logger.info('Approved plan', { instanceId });
    return instance;
  }

  /**
   * Update plan content while in planning mode.
   */
  updatePlanContent(instanceId: string, planContent: string): Instance {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (!instance.planMode.enabled) {
      throw new Error('Instance is not in plan mode');
    }

    instance.planMode.planContent = planContent;

    this.emitter.emit('state-update', {
      instanceId,
      status: instance.status,
      planMode: instance.planMode,
    });

    return instance;
  }

  /**
   * Get plan mode state for an instance.
   */
  getPlanModeState(instanceId: string): {
    enabled: boolean;
    state: string;
    planContent?: string;
  } {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    return {
      enabled: instance.planMode.enabled,
      state: instance.planMode.state,
      planContent: instance.planMode.planContent,
    };
  }
}
