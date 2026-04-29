import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  WorkflowCanTransitionPayloadSchema,
  WorkflowNlSuggestPayloadSchema,
} from '@contracts/schemas/workflow';
import { getNlWorkflowClassifier, type NlWorkflowClassifier } from '../../session/nl-workflow-classifier';
import { getWorkflowManager, type WorkflowManager } from '../../workflows/workflow-manager';
import { evaluateTransition } from '../../workflows/workflow-transition-policy';

export interface RegisterWorkflowHandlersDeps {
  workflowManager?: WorkflowManager;
  classifier?: NlWorkflowClassifier;
}

export function registerWorkflowHandlers(deps: RegisterWorkflowHandlersDeps = {}): void {
  const manager = deps.workflowManager ?? getWorkflowManager();
  const classifier = deps.classifier ?? getNlWorkflowClassifier();

  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_CAN_TRANSITION,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          WorkflowCanTransitionPayloadSchema,
          payload,
          'WORKFLOW_CAN_TRANSITION',
        );
        const requestedTemplate = manager.getTemplate(validated.templateId);
        if (!requestedTemplate) {
          return errorResponse('WORKFLOW_TEMPLATE_NOT_FOUND', `Template not found: ${validated.templateId}`);
        }

        const activeExecutionId = manager.getActiveExecutionForInstance(validated.instanceId);
        const activeExecution = activeExecutionId ? manager.getExecution(activeExecutionId) : undefined;
        const activeTemplate = activeExecution ? manager.getTemplate(activeExecution.templateId) : undefined;
        const policy = evaluateTransition({
          current: activeExecution && activeTemplate
            ? { execution: activeExecution, template: activeTemplate }
            : null,
          requested: {
            instanceId: validated.instanceId,
            template: requestedTemplate,
          },
          source: validated.source,
        });

        return {
          success: true,
          data: {
            policy,
            activeExecutionId: activeExecution?.id ?? null,
            requestedTemplateId: requestedTemplate.id,
          },
        };
      } catch (error) {
        return errorResponse('WORKFLOW_CAN_TRANSITION_FAILED', (error as Error).message);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKFLOW_NL_SUGGEST,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          WorkflowNlSuggestPayloadSchema,
          payload,
          'WORKFLOW_NL_SUGGEST',
        );
        return {
          success: true,
          data: classifier.classify(validated.promptText, {
            provider: validated.provider,
            workingDirectory: validated.workingDirectory,
          }),
        };
      } catch (error) {
        return errorResponse('WORKFLOW_NL_SUGGEST_FAILED', (error as Error).message);
      }
    },
  );
}

function errorResponse(code: string, message: string): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message,
      timestamp: Date.now(),
    },
  };
}
