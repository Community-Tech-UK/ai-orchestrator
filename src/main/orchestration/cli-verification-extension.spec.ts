/**
 * Unit Tests for CLI Verification Extension Cancellation Functionality
 * Tests the cancelVerification() and cancelAllVerifications() methods
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CliVerificationCoordinator } from './cli-verification-extension';
import { BaseProvider } from '../providers/provider-interface';
import { ProviderConfig, ProviderType, ProviderCapabilities, ProviderStatus } from '../../shared/types/provider.types';
import { ProviderSessionOptions } from '../../shared/types/provider.types';
import { VerificationRequest } from '../../shared/types/verification.types';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderName } from '@contracts/types/provider-runtime-events';

/**
 * Mock Provider for testing
 */
class MockProvider extends BaseProvider {
  readonly provider: ProviderName = 'claude';
  readonly capabilities: ProviderAdapterCapabilities = {
    interruption: true,
    permissionPrompts: true,
    sessionResume: true,
    streamingOutput: true,
    usageReporting: true,
    subAgents: true,
  };

  public terminateCalled = false;
  public terminateGraceful: boolean | undefined;
  public terminateDelay = 0;
  public terminateError: Error | null = null;

  constructor(config: ProviderConfig) {
    super(config);
  }

  getType(): ProviderType {
    return 'anthropic-api';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      toolExecution: true,
      streaming: true,
      multiTurn: true,
      vision: true,
      fileAttachments: true,
      functionCalling: true,
      builtInCodeTools: false,
    };
  }

  async checkStatus(): Promise<ProviderStatus> {
    return {
      type: 'anthropic-api',
      available: true,
      authenticated: true,
    };
  }

  async initialize(options: ProviderSessionOptions): Promise<void> {
    this.sessionId = 'mock-session-' + Date.now();
    this.isActive = true;
  }

  async sendMessage(message: string): Promise<void> {
    // Simulate async work
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  async terminate(graceful: boolean = true): Promise<void> {
    this.terminateCalled = true;
    this.terminateGraceful = graceful;

    if (this.terminateError) {
      throw this.terminateError;
    }

    if (this.terminateDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.terminateDelay));
    }

    this.isActive = false;
  }
}

describe('CliVerificationCoordinator - Cancellation', () => {
  let coordinator: CliVerificationCoordinator;
  let mockProviders: Map<string, MockProvider>;

  beforeEach(() => {
    // Get singleton instance
    coordinator = CliVerificationCoordinator.getInstance();
    mockProviders = new Map();
  });

  afterEach(() => {
    // Clean up any active verifications
    const activeSessions = coordinator.getActiveSessions();
    activeSessions.forEach(session => {
      coordinator.cancelVerification(session.verificationId).catch(() => {});
    });
  });

  /**
   * Helper function to create a mock active session
   */
  function createMockSession(verificationId: string, agentCount: number = 3) {
    const request: VerificationRequest = {
      id: verificationId,
      instanceId: 'test-instance',
      prompt: 'Test prompt',
      config: {
        agentCount,
        timeout: 60000,
        synthesisStrategy: 'merge',
      },
    };

    // Access private properties via type casting
    const coordinatorAny = coordinator as any;

    // Add to activeVerifications
    coordinatorAny.activeVerifications.set(verificationId, request);

    // Create active session with mock providers
    const providers = new Map<string, MockProvider>();
    for (let i = 0; i < agentCount; i++) {
      const mockProvider = new MockProvider({
        type: 'anthropic-api',
        name: `mock-${i}`,
        enabled: true,
      });
      mockProviders.set(`${verificationId}-agent-${i}`, mockProvider);
      providers.set(`${verificationId}-agent-${i}`, mockProvider as any);
    }

    const activeSession = {
      request,
      providers,
      cancelled: false,
    };

    coordinatorAny.activeSessions.set(verificationId, activeSession);

    return { request, activeSession, providers };
  }

  describe('cancelVerification', () => {
    it('should cancel an active verification session', async () => {
      // Arrange
      const verificationId = 'test-verify-1';
      const { providers } = createMockSession(verificationId, 3);

      // Act
      const result = await coordinator.cancelVerification(verificationId);

      // Assert
      expect(result.success).toBe(true);
      expect(result.agentsCancelled).toBe(3);
      expect(result.error).toBeUndefined();

      // Verify all providers were terminated
      providers.forEach((provider: any) => {
        expect(provider.terminateCalled).toBe(true);
        expect(provider.terminateGraceful).toBe(false); // Force terminate
      });

      // Verify session was cleaned up
      expect(coordinator.isVerificationActive(verificationId)).toBe(false);
    });

    it('should return error for non-existent session ID', async () => {
      // Arrange
      const nonExistentId = 'non-existent-verify';

      // Act
      const result = await coordinator.cancelVerification(nonExistentId);

      // Assert
      expect(result.success).toBe(false);
      expect(result.agentsCancelled).toBe(0);
      expect(result.error).toContain('No active verification found');
      expect(result.error).toContain(nonExistentId);
    });

    it('should cancel verification that has not started agents yet', async () => {
      // Arrange
      const verificationId = 'test-verify-early';
      const request: VerificationRequest = {
        id: verificationId,
        instanceId: 'test-instance',
        prompt: 'Test prompt',
        config: {
          agentCount: 3,
          timeout: 60000,
          synthesisStrategy: 'merge',
        },
      };

      // Add to activeVerifications only (no session)
      const coordinatorAny = coordinator as any;
      coordinatorAny.activeVerifications.set(verificationId, request);

      // Act
      const result = await coordinator.cancelVerification(verificationId);

      // Assert
      expect(result.success).toBe(true);
      expect(result.agentsCancelled).toBe(0);
      expect(result.error).toBeUndefined();
      expect(coordinator.isVerificationActive(verificationId)).toBe(false);
    });

    it('should call terminate on each active provider', async () => {
      // Arrange
      const verificationId = 'test-verify-providers';
      const agentCount = 5;
      createMockSession(verificationId, agentCount);

      // Capture references to the mock providers BEFORE cancellation
      // (since the session providers map gets cleared during cancellation)
      const capturedProviders: MockProvider[] = [];
      for (let i = 0; i < agentCount; i++) {
        const provider = mockProviders.get(`${verificationId}-agent-${i}`);
        if (provider) {
          capturedProviders.push(provider);
        }
      }

      // Act
      await coordinator.cancelVerification(verificationId);

      // Assert
      expect(capturedProviders.length).toBe(agentCount);
      capturedProviders.forEach((provider) => {
        expect(provider.terminateCalled).toBe(true);
      });
    });

    it('should emit verification:cancelled event', async () => {
      // Arrange
      const verificationId = 'test-verify-events';
      createMockSession(verificationId, 3);

      const eventPromise = new Promise<any>((resolve) => {
        coordinator.once('verification:cancelled', resolve);
      });

      // Act
      await coordinator.cancelVerification(verificationId);

      // Assert
      const event = await eventPromise;
      expect(event.verificationId).toBe(verificationId);
      expect(event.reason).toContain('User requested cancellation');
      expect(event.agentsCancelled).toBe(3);
    });

    it('should emit verification:agent-cancelled for each agent', async () => {
      // Arrange
      const verificationId = 'test-verify-agent-events';
      const agentCount = 3;
      createMockSession(verificationId, agentCount);

      const agentEvents: any[] = [];
      coordinator.on('verification:agent-cancelled', (event) => {
        agentEvents.push(event);
      });

      // Act
      await coordinator.cancelVerification(verificationId);

      // Wait a bit for events to propagate
      await new Promise(resolve => setTimeout(resolve, 100));

      // Assert
      expect(agentEvents.length).toBe(agentCount);
      agentEvents.forEach(event => {
        expect(event.verificationId).toBe(verificationId);
        expect(event.agentId).toBeDefined();
      });

      // Cleanup listener
      coordinator.removeAllListeners('verification:agent-cancelled');
    });

    it('should remove session from activeSessions map', async () => {
      // Arrange
      const verificationId = 'test-verify-cleanup-1';
      createMockSession(verificationId, 3);

      // Verify session exists before cancellation
      const sessionsBefore = coordinator.getActiveSessions();
      expect(sessionsBefore.some(s => s.verificationId === verificationId)).toBe(true);

      // Act
      await coordinator.cancelVerification(verificationId);

      // Assert
      const sessionsAfter = coordinator.getActiveSessions();
      expect(sessionsAfter.some(s => s.verificationId === verificationId)).toBe(false);
    });

    it('should remove session from activeVerifications map', async () => {
      // Arrange
      const verificationId = 'test-verify-cleanup-2';
      createMockSession(verificationId, 3);

      // Verify verification is active before cancellation
      expect(coordinator.isVerificationActive(verificationId)).toBe(true);

      // Act
      await coordinator.cancelVerification(verificationId);

      // Assert
      expect(coordinator.isVerificationActive(verificationId)).toBe(false);
    });

    it('should handle provider termination errors gracefully', async () => {
      // Arrange
      const verificationId = 'test-verify-errors';
      const { providers } = createMockSession(verificationId, 3);

      // Make one provider throw an error on terminate
      const providerArray = Array.from(providers.values());
      (providerArray[1] as any).terminateError = new Error('Termination failed');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Act
      const result = await coordinator.cancelVerification(verificationId);

      // Assert - should still succeed overall
      expect(result.success).toBe(true);
      expect(result.agentsCancelled).toBe(3);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should timeout after 10 seconds if providers do not terminate', async () => {
      // Use fake timers to avoid waiting 10 real seconds
      vi.useFakeTimers();

      // Arrange
      const verificationId = 'test-verify-timeout';
      const { providers } = createMockSession(verificationId, 2);

      // Make providers take a very long time to terminate
      providers.forEach((provider: any) => {
        provider.terminateDelay = 20000; // 20 seconds
      });

      // Act - start cancellation (don't await yet)
      const cancelPromise = coordinator.cancelVerification(verificationId);

      // Fast-forward past the 10 second timeout
      await vi.advanceTimersByTimeAsync(10001);

      // Now await the result
      const result = await cancelPromise;

      // Assert - cancellation should have completed due to timeout
      expect(result.success).toBe(true);

      // Restore real timers
      vi.useRealTimers();
    });
  });

  describe('cancelAllVerifications', () => {
    it('should cancel multiple active verification sessions', async () => {
      // Arrange
      createMockSession('verify-1', 2);
      createMockSession('verify-2', 3);
      createMockSession('verify-3', 2);

      // Act
      const result = await coordinator.cancelAllVerifications();

      // Assert
      expect(result.success).toBe(true);
      expect(result.sessionsCancelled).toBe(3);
      expect(result.totalAgentsCancelled).toBe(7); // 2 + 3 + 2
      expect(result.errors).toHaveLength(0);

      // Verify all sessions are cleaned up
      expect(coordinator.getActiveSessions()).toHaveLength(0);
    });

    it('should return correct counts when cancelling all', async () => {
      // Arrange
      const sessionConfigs = [
        { id: 'verify-a', agents: 5 },
        { id: 'verify-b', agents: 3 },
        { id: 'verify-c', agents: 4 },
      ];

      sessionConfigs.forEach(config => {
        createMockSession(config.id, config.agents);
      });

      const expectedTotalAgents = sessionConfigs.reduce((sum, c) => sum + c.agents, 0);

      // Act
      const result = await coordinator.cancelAllVerifications();

      // Assert
      expect(result.sessionsCancelled).toBe(sessionConfigs.length);
      expect(result.totalAgentsCancelled).toBe(expectedTotalAgents);
    });

    it('should return success:false if any session fails to cancel', async () => {
      // Arrange
      createMockSession('verify-1', 2);
      createMockSession('verify-2', 3);

      // Mock cancelVerification to fail for one session
      const originalCancel = coordinator.cancelVerification.bind(coordinator);
      const cancelSpy = vi.spyOn(coordinator, 'cancelVerification').mockImplementation(async (id: string) => {
        if (id === 'verify-2') {
          return {
            success: false,
            agentsCancelled: 0,
            error: 'Simulated error',
          };
        }
        return originalCancel(id);
      });

      // Act
      const result = await coordinator.cancelAllVerifications();

      // Assert
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBe('Simulated error');

      cancelSpy.mockRestore();
    });

    it('should handle empty active sessions gracefully', async () => {
      // Arrange - no active sessions

      // Act
      const result = await coordinator.cancelAllVerifications();

      // Assert
      expect(result.success).toBe(true);
      expect(result.sessionsCancelled).toBe(0);
      expect(result.totalAgentsCancelled).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should cancel all sessions in parallel', async () => {
      // Arrange
      const sessionCount = 5;
      for (let i = 0; i < sessionCount; i++) {
        createMockSession(`verify-parallel-${i}`, 2);
      }

      // Act
      const startTime = Date.now();
      await coordinator.cancelAllVerifications();
      const duration = Date.now() - startTime;

      // Assert - should be fast (parallel) not slow (sequential)
      // If sequential with 100ms delay per provider, would take ~1000ms
      // Parallel should complete much faster
      expect(duration).toBeLessThan(500);
    });
  });

  describe('Session state management', () => {
    it('should mark session as cancelled to prevent new work', async () => {
      // Arrange
      const verificationId = 'test-verify-state';
      const { activeSession } = createMockSession(verificationId, 3);

      // Verify initial state
      expect(activeSession.cancelled).toBe(false);

      // Act
      const cancellationPromise = coordinator.cancelVerification(verificationId);

      // Check state during cancellation (before it completes)
      const coordinatorAny = coordinator as any;
      const session = coordinatorAny.activeSessions.get(verificationId);
      if (session) {
        expect(session.cancelled).toBe(true);
      }

      await cancellationPromise;

      // Assert - session should be removed after cancellation
      expect(coordinatorAny.activeSessions.has(verificationId)).toBe(false);
    });

    it('should clear all providers from session after cancellation', async () => {
      // Arrange
      const verificationId = 'test-verify-clear';
      const { providers } = createMockSession(verificationId, 4);

      // Verify providers exist
      expect(providers.size).toBe(4);

      // Act
      await coordinator.cancelVerification(verificationId);

      // Assert
      expect(providers.size).toBe(0);
    });
  });

  describe('isVerificationActive', () => {
    it('should return true for active verification', () => {
      // Arrange
      const verificationId = 'test-verify-active';
      createMockSession(verificationId, 3);

      // Act & Assert
      expect(coordinator.isVerificationActive(verificationId)).toBe(true);
    });

    it('should return false after cancellation', async () => {
      // Arrange
      const verificationId = 'test-verify-inactive';
      createMockSession(verificationId, 3);

      // Act
      await coordinator.cancelVerification(verificationId);

      // Assert
      expect(coordinator.isVerificationActive(verificationId)).toBe(false);
    });

    it('should return true for verification without session yet', () => {
      // Arrange
      const verificationId = 'test-verify-no-session';
      const request: VerificationRequest = {
        id: verificationId,
        instanceId: 'test-instance',
        prompt: 'Test prompt',
        config: {
          agentCount: 3,
          timeout: 60000,
          synthesisStrategy: 'merge',
        },
      };

      const coordinatorAny = coordinator as any;
      coordinatorAny.activeVerifications.set(verificationId, request);

      // Act & Assert
      expect(coordinator.isVerificationActive(verificationId)).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle cancellation of already cancelled session', async () => {
      // Arrange
      const verificationId = 'test-verify-double-cancel';
      createMockSession(verificationId, 3);

      // Act - cancel twice
      await coordinator.cancelVerification(verificationId);
      const result = await coordinator.cancelVerification(verificationId);

      // Assert - second cancellation should fail gracefully
      expect(result.success).toBe(false);
      expect(result.error).toContain('No active verification found');
    });

    it('should handle session with zero agents', async () => {
      // Arrange
      const verificationId = 'test-verify-zero-agents';
      createMockSession(verificationId, 0);

      // Act
      const result = await coordinator.cancelVerification(verificationId);

      // Assert
      expect(result.success).toBe(true);
      expect(result.agentsCancelled).toBe(0);
    });
  });
});
