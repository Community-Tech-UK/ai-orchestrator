import type {
  ContextUsage,
  Instance,
  InstanceStatus,
  InstanceWaitReason,
  OutputMessage,
  SessionDiffStats,
} from '../../shared/types/instance.types';
import type { ErrorInfo } from '../../shared/types/ipc.types';
import type {
  ProviderName,
  ProviderRuntimeEvent,
  ProviderRuntimeEventRaw,
} from '@contracts/types/provider-runtime-events';
import type { TokenBudgetTracker } from '../context/token-budget-tracker.js';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { SessionDiffTracker } from './session-diff-tracker';

/**
 * Dependencies required by the communication manager.
 */
export interface CommunicationDependencies {
  getInstance: (id: string) => Instance | undefined;
  getAdapter: (id: string) => CliAdapter | undefined;
  setAdapter: (id: string, adapter: CliAdapter) => void;
  deleteAdapter: (id: string) => boolean;
  transitionState?: (instance: Instance, status: InstanceStatus) => void;
  queueUpdate: (
    instanceId: string,
    status: InstanceStatus,
    contextUsage?: ContextUsage,
    diffStats?: SessionDiffStats | null,
    displayName?: string,
    error?: ErrorInfo,
    executionLocation?: import('../../shared/types/worker-node.types').ExecutionLocation,
    sessionState?: {
      providerSessionId?: string;
      restartEpoch?: number;
      adapterGeneration?: number;
      activeTurnId?: string;
      interruptRequestId?: string;
      interruptRequestedAt?: number;
      interruptPhase?: Instance['interruptPhase'];
      lastTurnOutcome?: Instance['lastTurnOutcome'];
      supersededBy?: string;
      cancelledForEdit?: boolean;
      recoveryMethod?: Instance['recoveryMethod'];
      archivedUpToMessageId?: string;
      historyThreadId?: string;
    },
    activityState?: import('../../shared/types/activity.types').ActivityState,
    currentModel?: string,
    waitReason?: InstanceWaitReason | null,
  ) => void;
  getDiffTracker?: (id: string) => SessionDiffTracker | undefined;
  processOrchestrationOutput: (instanceId: string, content: string) => void;
  onInterruptedExit: (instanceId: string) => Promise<void>;
  onUnexpectedExit?: (instanceId: string) => Promise<void>;
  /**
   * Invoked when the adapter reports a settled status (idle/ready/
   * waiting_for_input) while the instance is still in an in-place interrupt
   * state ('interrupting'/'cancelling'). Lets the interrupt machinery disarm
   * its force-abort net instead of force-cancelling a session the CLI already
   * settled. See InterruptRespawnHandler.noteInterruptSettled().
   */
  onInterruptSettled?: (instanceId: string) => void;
  onChildExit?: (childId: string, instance: Instance, exitCode: number | null) => void | Promise<void>;
  ingestContext?: (instance: Instance, message: OutputMessage) => void;
  ingestToRLM: (instanceId: string, message: OutputMessage) => void;
  ingestToUnifiedMemory: (instance: Instance, message: OutputMessage) => void;
  compactContext?: (instanceId: string) => Promise<void>;
  refreshAdapterRuntimeConfig?: (instanceId: string) => Promise<void>;
  onOutput?: (instanceId: string, content?: string) => void;
  onToolStateChange?: (instanceId: string, state: 'generating' | 'tool_executing' | 'idle') => void;
  /**
   * Invoked when a turn stops on a provider rate/session limit. Lets the
   * (opt-in) regular-session auto-resume machinery park the instance and
   * schedule a resume after the quota window resets. Returns `'parked'` when it
   * took ownership of the stopped turn (the caller should leave the instance
   * idle instead of marking it errored), `'already-parked'` when a turn
   * arrived while the instance was already parked (e.g. from a path that
   * bypasses the renderer's quota-park gate), or `'skipped'` to fall through
   * to normal handling.
   */
  onProviderLimitTurn?: (params: {
    instanceId: string;
    resetAtHint: number | null;
    reason: string;
    resumePrompt: string | null;
  }) => 'parked' | 'already-parked' | 'skipped';
  createSnapshot?: (instanceId: string, name: string, description: string | undefined, trigger: 'checkpoint' | 'auto') => void;
  getBudgetTracker?: (instanceId: string) => TokenBudgetTracker | undefined;
  getContextUsage?: (instanceId: string) => ContextUsage | undefined;
  emitProviderRuntimeEvent?: (
    instanceId: string,
    event: ProviderRuntimeEvent,
    options?: {
      provider?: ProviderName;
      sessionId?: string;
      timestamp?: number;
      raw?: ProviderRuntimeEventRaw;
    },
  ) => void;
  captureProviderRuntimeEvent?: (
    instanceId: string,
    event: ProviderRuntimeEvent,
    options: {
      provider?: ProviderName;
      sessionId?: string;
      timestamp?: number;
      raw: ProviderRuntimeEventRaw;
    },
  ) => void;
}
