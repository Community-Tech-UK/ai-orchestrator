import type { Instance, InstanceStatus } from '../../../shared/types/instance.types';
import { getAgentById, type AgentProfile, type AgentToolPermissions } from '../../../shared/types/agent.types';
import { generateId } from '../../../shared/utils/id-generator';
import type { CliAdapter, UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory';
import type { CliType } from '../../cli/cli-detection';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import { markAdapterStopping } from '../../providers/adapter-stop-state';
import { stampRtkArm } from '../../cli/rtk/rtk-rollout';
import { getAgentRegistry } from '../../agents/agent-registry';
import { getSessionMutex } from '../../session/session-mutex';
import { getSessionContinuityManager } from '../../session/session-continuity';
import { getLogger } from '../../logging/logger';
import { errorDiagnostic } from '../../logging/source-diagnostics';
import type { LifecycleDependencies } from '../instance-lifecycle.types';
import type { SpawnConfigBuilder } from './spawn-config-builder';
import { attachToolFilterMetadata, buildToolPermissionConfig } from './tool-permission-config';

const logger = getLogger('InstanceLifecycle');

export interface AgentModeChangeDeps extends Pick<LifecycleDependencies,
  'getInstance' | 'getAdapter' | 'deleteAdapter' | 'setAdapter' | 'setupAdapterEvents' | 'queueUpdate' | 'holdContinuityUntilAnswered'> {
  transitionState: (instance: Instance, status: InstanceStatus) => void;
  getAdapterRuntimeCapabilities: (adapter?: CliAdapter) => { supportsResume: boolean; supportsForkSession: boolean };
  resolveCliTypeForInstance: (instance: Instance) => Promise<CliType>;
  residentClaudeForSpawn: (instance: Instance) => boolean;
  createRuntimeAdapter: (cliType: CliType, options: UnifiedSpawnOptions, location?: ExecutionLocation) => Promise<CliAdapter>;
  waitForResumeHealth: (instanceId: string) => Promise<boolean>;
  waitForInputReadinessBoundary: (instanceId: string, adapter?: CliAdapter) => Promise<void>;
  prepareStatusForAdapterInput: (instance: Instance) => void;
  buildFallbackHistory: (instance: Instance, reason: string) => Promise<string>;
  buildReplayContinuityMessage: (instance: Instance, reason: string) => string;
  spawnConfigBuilder: Pick<SpawnConfigBuilder, 'getMcpConfig' | 'getChromeDevtoolsMcpOptions' | 'getBrowserGatewayMcpOptions' | 'getPermissionHookPath' | 'getRtkSpawnConfig'>;
  emitAgentChanged: (payload: { instanceId: string; oldAgentId: string; newAgentId: string; agentName: string }) => void;
  emitSystemNotice: (instance: Instance, content: string, metadata: Record<string, unknown>) => void;
}

/** Describe the permissions actually passed to the replacement runtime. */
function modeReceipt(agent: AgentProfile, permissions: AgentToolPermissions, yoloMode: boolean): string {
  const edits = permissions.write === 'deny' ? 'edits are off' : 'edits are allowed';
  const reading = permissions.read === 'deny' ? 'file reading is off'
    : agent.mode === 'custom' || agent.mode === 'observer' ? 'file reading is allowed'
      : `the session can read and ${agent.mode}`;
  const shell = permissions.bash === 'deny' ? ' Shell commands are off.'
    : permissions.bash === 'ask' && !yoloMode ? ' Shell commands may require approval.' : '';
  return `Switched to ${agent.name} mode: ${edits}, ${reading}.${shell}`;
}

/** The facade retains its public signature and model-facing prompt bytes. */
export async function changeAgentModeImpl(deps: AgentModeChangeDeps, instanceId: string, newAgentId: string): Promise<Instance> {

    const instance = deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const release = await getSessionMutex().acquire(instanceId, 'agent-mode-change');
    try {
      if (instance.status === 'busy') {
        throw new Error('Cannot change agent mode while instance is busy. Please wait for the current operation to complete.');
      }

      if (instance.agentId === newAgentId) {
        return instance;
      }

      // Resolve from registry first (allows markdown-defined agents). Fall back to built-ins for safety.
      const newAgent = await getAgentRegistry().resolveAgent(instance.workingDirectory, newAgentId);
      if (!newAgent) {
        const builtin = getAgentById(newAgentId);
        if (!builtin) throw new Error(`Agent ${newAgentId} not found`);
      }

      const oldAgentId = instance.agentId;
      logger.info('Changing agent mode', { instanceId, oldAgentId, newAgentId });

      const hasConversation = instance.outputBuffer.some(
        (msg) => msg.type === 'user' || msg.type === 'assistant'
      );

      // Terminate existing adapter
      const oldAdapter = deps.getAdapter(instanceId);
      const oldAdapterCapabilities = deps.getAdapterRuntimeCapabilities(oldAdapter);
      if (oldAdapter) {
        // The stop is ours. Without this fence the old process's exit (143) reads
        // as an unexpected exit of an idle session, starts an auto-respawn that
        // races the spawn below, and the session is destroyed (LT-1108).
        markAdapterStopping(oldAdapter);
        await oldAdapter.terminate(true);
        deps.deleteAdapter(instanceId);
      }

      // Update instance with new agent
      instance.agentId = newAgentId;
      instance.agentMode = newAgent.mode;
      deps.transitionState(instance, 'initializing');

      // If leaving plan mode, reset plan mode state
      if (instance.planMode.enabled && newAgent.mode !== 'plan') {
        instance.planMode = {
          enabled: false,
          state: 'off',
          planContent: undefined,
          approvedAt: undefined
        };
        logger.info('Auto-exited plan mode due to agent mode change', { instanceId, newAgentId });
      }

      const effectivePermissions = instance.toolPermissionsOverride ?? newAgent.permissions;
      const toolPermissions = buildToolPermissionConfig(
        effectivePermissions,
        {
          allowedToolsPolicy: 'standard-unless-yolo',
          yoloMode: instance.yoloMode,
        },
      );
      attachToolFilterMetadata(instance, toolPermissions.toolFilter);

      const cliType = await deps.resolveCliTypeForInstance(instance);
      const shouldResume = hasConversation && oldAdapterCapabilities.supportsResume;
      const shouldForkSession = shouldResume && oldAdapterCapabilities.supportsForkSession;

      // Resume FROM the live id: a fork mints its own target, so `newSessionId`
      // has no transcript and passing it as the source destroys the session (LT-008).
      const resumeSourceSessionId = instance.sessionId;
      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : (shouldResume ? instance.sessionId : generateId());
      instance.sessionId = newSessionId;

      const spawnOptions: UnifiedSpawnOptions = {
        instanceId: instance.id,
        sessionId: shouldResume ? resumeSourceSessionId : newSessionId,
        workingDirectory: instance.workingDirectory,
        systemPrompt: newAgent.systemPrompt,
        yoloMode: instance.yoloMode,
        launchMode: instance.launchMode,
        model: instance.currentModel,
        reasoningEffort: instance.reasoningEffort,
        fastMode: instance.fastMode,
        residentClaude: deps.residentClaudeForSpawn(instance),
        allowedTools: toolPermissions.allowedTools,
        disallowedTools: toolPermissions.disallowedToolsForSpawn,
        bare: instance.bareMode === true,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: deps.spawnConfigBuilder.getMcpConfig(instance.executionLocation, instance.id, cliType, instance.workingDirectory),
        chromeDevtoolsMcp: deps.spawnConfigBuilder.getChromeDevtoolsMcpOptions(instance.executionLocation, instance.id) ?? undefined,
        browserGatewayMcp: deps.spawnConfigBuilder.getBrowserGatewayMcpOptions(
          instance.executionLocation,
          instance.id,
          cliType,
        ) ?? undefined,
        nodePlacement: instance.nodePlacement,
        permissionHookPath: deps.spawnConfigBuilder.getPermissionHookPath(instance.yoloMode),
        rtk: stampRtkArm(instance, deps.spawnConfigBuilder.getRtkSpawnConfig(instance.id), cliType, instance.executionLocation.type === 'local'),
      };

      let adapter = await deps.createRuntimeAdapter(cliType, spawnOptions, instance.executionLocation);

      deps.setupAdapterEvents(instanceId, adapter);
      deps.setAdapter(instanceId, adapter);

      try {
        let pid: number;
        try {
          pid = await adapter.spawn();
          instance.processId = pid;
          if (shouldResume && !(await deps.waitForResumeHealth(instanceId))) {
            throw new Error('Native resume did not stabilize after agent mode change');
          }
          await deps.waitForInputReadinessBoundary(instanceId, adapter);
        } catch (spawnError) {
          if (shouldResume) {
            logger.warn('Failed to spawn with resume, falling back to fresh session', { ...errorDiagnostic(spawnError), instanceId });
            // Strip listeners before terminate so the doomed adapter's exit is
            // not handled as a real instance exit → `error` (LT-008).
            adapter.removeAllListeners();
            await adapter.terminate(true);

            const fallbackOptions = { ...spawnOptions, resume: false, forkSession: false, sessionId: generateId(),
              mcpConfig: deps.spawnConfigBuilder.getMcpConfig(instance.executionLocation, instance.id, cliType, instance.workingDirectory),
              browserGatewayMcp: deps.spawnConfigBuilder.getBrowserGatewayMcpOptions(instance.executionLocation, instance.id, cliType) ?? undefined,
            };
            instance.sessionId = fallbackOptions.sessionId;
            adapter = await deps.createRuntimeAdapter(cliType, fallbackOptions, instance.executionLocation);
            deps.setupAdapterEvents(instanceId, adapter);
            deps.setAdapter(instanceId, adapter);

            pid = await adapter.spawn();
            try {
              await getSessionContinuityManager().writeThroughIdentityLocked(instanceId, { sessionId: fallbackOptions.sessionId, resumeCursor: null });
            } catch (err) {
              logger.warn('writeThroughIdentity failed after fresh fallback (agent-mode-change)', {
                instanceId,
                ...errorDiagnostic(err),
              });
            }
            await deps.waitForInputReadinessBoundary(instanceId, adapter);

            if (hasConversation) {
              deps.prepareStatusForAdapterInput(instance);
              const history = await deps.buildFallbackHistory(instance, 'resume-failed-fallback');
              deps.holdContinuityUntilAnswered?.(instanceId, history);
              await adapter.sendInput(history);
            }
          } else {
            throw spawnError;
          }
        }

        instance.processId = pid;
        deps.transitionState(instance, 'idle');
        logger.info('Agent mode changed successfully', { instanceId, newAgentId, pid, resumed: shouldResume });

        if (!shouldResume && hasConversation) {
          const history = deps.buildReplayContinuityMessage(instance, 'agent-mode-change');
          deps.holdContinuityUntilAnswered?.(instanceId, history);
          await adapter.sendInput(history);
        }

        // Build a mode transition message. When resuming, the system prompt can't be changed,
        // so we send an authoritative message that overrides the previous mode's instructions.
        let modeChangeMessage: string;
        if (oldAgentId === 'plan' && newAgentId !== 'plan') {
          // Explicitly revoke plan mode restrictions since the old system prompt persists in the session
          modeChangeMessage = `[SYSTEM MODE CHANGE - IMPORTANT]
Your mode has been changed from PLAN to ${newAgent.name.toUpperCase()}.
ALL previous PLAN MODE restrictions are now LIFTED. You are NO LONGER in plan mode.
You now have FULL access to: read files, write files, edit files, execute bash commands, and all other tools.
${newAgent.systemPrompt ? `New instructions: ${newAgent.systemPrompt}` : `You are in ${newAgent.name} mode: ${newAgent.description || 'Full access mode.'}`}
Proceed with implementation. Do NOT request to switch modes - you are already in ${newAgent.name} mode.`;
        } else {
          modeChangeMessage = `[System: Agent mode changed to ${newAgent.name}. ${newAgent.description || ''}${newAgent.systemPrompt ? `\n\nNew instructions:\n${newAgent.systemPrompt}` : ''}]`;
        }
        await adapter.sendInput(modeChangeMessage);
        // Only acknowledge a mode message the CLI accepted. This receipt is
        // transcript-only; it must never be appended to the model-facing text.
        try {
          deps.emitSystemNotice(instance, modeReceipt(newAgent, effectivePermissions, instance.yoloMode), {
            kind: 'agent-mode-changed', displayOnly: true,
          });
        } catch (error) {
          logger.warn('Agent mode changed but its receipt could not be rendered', { instanceId, ...errorDiagnostic(error) });
        }
      } catch (error) {
        deps.transitionState(instance, 'error');
        logger.error('Failed to change agent mode', undefined, { ...errorDiagnostic(error), instanceId, newAgentId });
        throw error;
      }

      deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
      deps.emitAgentChanged( {
        instanceId,
        oldAgentId,
        newAgentId,
        agentName: newAgent.name
      });

      return instance;
    } finally {
      release();
    }
  }
