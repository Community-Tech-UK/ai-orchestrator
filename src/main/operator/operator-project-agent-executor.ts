import type {
  OperatorProjectRecord,
  OperatorRunNodeRecord,
  OperatorRunRecord,
  OperatorRunStatus,
} from '../../shared/types/operator.types';
import type {
  Instance,
  InstanceCreateConfig,
} from '../../shared/types/instance.types';
import type { InstanceSettledWaitOptions } from '../instance/instance-manager';
import { OperatorRunStore } from './operator-run-store';
import { getOperatorDatabase } from './operator-database';
import {
  planProjectVerification,
  type OperatorVerificationPlan,
} from './operator-verification-planner';

export interface ProjectAgentInstanceManager {
  createInstance(config: InstanceCreateConfig): Promise<Instance>;
  waitForInstanceSettled(instanceId: string, options?: InstanceSettledWaitOptions): Promise<Instance | undefined>;
}

export interface ProjectAgentExecutionInput {
  run: OperatorRunRecord;
  node: OperatorRunNodeRecord;
  project: OperatorProjectRecord;
  goal: string;
  promptOverride?: string;
}

export interface ProjectAgentExecutionResult {
  status: OperatorRunStatus;
  outputJson: Record<string, unknown>;
  externalRefKind?: OperatorRunNodeRecord['externalRefKind'];
  externalRefId?: string | null;
  error?: string | null;
}

export interface ProjectAgentExecutorConfig {
  instanceManager: ProjectAgentInstanceManager;
  runStore?: OperatorRunStore;
}

export class ProjectAgentExecutor {
  private readonly instanceManager: ProjectAgentInstanceManager;
  private readonly runStore: OperatorRunStore;

  constructor(config: ProjectAgentExecutorConfig) {
    this.instanceManager = config.instanceManager;
    this.runStore = config.runStore ?? new OperatorRunStore(getOperatorDatabase().db);
  }

  async execute(input: ProjectAgentExecutionInput): Promise<ProjectAgentExecutionResult> {
    const verificationPlan = await planProjectVerification(input.project.canonicalPath);
    const initialPrompt = input.promptOverride
      ?? buildProjectAgentPrompt(input.goal, input.project, verificationPlan);
    const instance = await this.instanceManager.createInstance({
      workingDirectory: input.project.canonicalPath,
      displayName: `Operator: ${input.project.displayName}`,
      agentId: 'build',
      yoloMode: true,
      initialPrompt,
      metadata: {
        source: 'operator',
        operatorRunId: input.run.id,
        operatorNodeId: input.node.id,
        operatorProjectId: input.project.id,
      },
    });
    this.runStore.upsertInstanceLink({
      instanceId: instance.id,
      runId: input.run.id,
      nodeId: input.node.id,
    });

    const settled = await this.instanceManager.waitForInstanceSettled(instance.id, {
      afterTimestamp: instance.createdAt,
      timeoutMs: 30 * 60 * 1000,
    });
    const finalInstance = settled ?? instance;
    const finalMessage = [...(finalInstance.outputBuffer ?? [])]
      .reverse()
      .find((message) => message.type === 'assistant' || message.type === 'error' || message.type === 'system');
    const failed = finalInstance.status === 'error' || finalInstance.status === 'terminated';

    return {
      status: failed ? 'failed' : 'completed',
      externalRefKind: 'instance',
      externalRefId: instance.id,
      outputJson: {
        instanceId: instance.id,
        finalStatus: finalInstance.status,
        outputPreview: finalMessage?.content.slice(0, 2000) ?? null,
      },
      error: failed ? `Project agent ended with status ${finalInstance.status}` : null,
    };
  }
}

function buildProjectAgentPrompt(
  goal: string,
  project: OperatorProjectRecord,
  verificationPlan: OperatorVerificationPlan,
): string {
  const verificationLines = verificationPlan.checks.length > 0
    ? verificationPlan.checks.map((check) =>
      `- ${check.required ? 'required' : 'optional'}: ${check.command} ${check.args.join(' ')}`
    )
    : [`- No automated checks detected (${verificationPlan.fallbackReason ?? 'unknown project type'}). Inspect project docs and choose the safest available verification.`];

  return [
    `Operator delegated task for ${project.displayName}.`,
    '',
    'Work in this repository until the requested change is implemented properly.',
    'Follow the project instructions, inspect before editing, run focused verification, and report what changed.',
    '',
    'Suggested verification:',
    ...verificationLines,
    '',
    `Task: ${goal}`,
  ].join('\n');
}
