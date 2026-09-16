import { getLogger } from '../logging/logger';
import {
  CIRCUIT_BREAKER_CONFIG,
  type CircuitBreakerState,
} from './instance-communication.constants';

const logger = getLogger('InstanceCommunication');

export class InstanceCommunicationCircuitBreakers {
  private readonly states = new Map<string, CircuitBreakerState>();

  get(instanceId: string): CircuitBreakerState {
    let state = this.states.get(instanceId);
    if (!state) {
      state = {
        consecutiveEmptyResponses: 0,
        lastResponseTimestamp: 0,
        isTripped: false,
      };
      this.states.set(instanceId, state);
    }
    return state;
  }

  recordResponse(instanceId: string, hasContent: boolean, now = Date.now()): boolean {
    const state = this.get(instanceId);

    if (state.isTripped && (now - state.lastResponseTimestamp) > CIRCUIT_BREAKER_CONFIG.resetTimeoutMs) {
      logger.info('Resetting tripped circuit after timeout', { instanceId });
      state.isTripped = false;
      state.consecutiveEmptyResponses = 0;
    }

    if (state.isTripped) {
      if ((now - state.lastResponseTimestamp) < CIRCUIT_BREAKER_CONFIG.cooldownMs) {
        logger.info('Circuit tripped, in cooldown period', { instanceId });
        return false;
      }
      state.isTripped = false;
      state.consecutiveEmptyResponses = 0;
      logger.info('Cooldown expired, allowing retry', { instanceId });
    }

    state.lastResponseTimestamp = now;

    if (hasContent) {
      state.consecutiveEmptyResponses = 0;
      return true;
    }

    state.consecutiveEmptyResponses++;
    logger.info('Empty response recorded', { instanceId, count: state.consecutiveEmptyResponses });

    if (state.consecutiveEmptyResponses >= CIRCUIT_BREAKER_CONFIG.maxConsecutiveEmpty) {
      logger.warn('Circuit breaker tripped after consecutive empty responses', {
        instanceId,
        consecutiveEmptyResponses: state.consecutiveEmptyResponses,
      });
      state.isTripped = true;
      return false;
    }

    return true;
  }

  isTripped(instanceId: string): boolean {
    return this.states.get(instanceId)?.isTripped ?? false;
  }

  reset(instanceId: string): void {
    const state = this.states.get(instanceId);
    if (state) {
      state.isTripped = false;
      state.consecutiveEmptyResponses = 0;
      logger.info('Circuit breaker manually reset', { instanceId });
    }
  }

  noteToolActivity(instanceId: string): void {
    const state = this.get(instanceId);
    if (state.consecutiveEmptyResponses > 0) {
      state.consecutiveEmptyResponses = 0;
    }
  }

  delete(instanceId: string): void {
    this.states.delete(instanceId);
  }
}
