/**
 * Orchestration Handler - Executes orchestrator commands from Claude instances
 */

import { EventEmitter } from 'events';
import {
  OrchestratorCommand,
  SpawnChildCommand,
  MessageChildCommand,
  TerminateChildCommand,
  GetChildOutputCommand,
  parseOrchestratorCommands,
  formatCommandResponse,
  generateOrchestrationPrompt,
} from './orchestration-protocol';

export interface OrchestrationContext {
  instanceId: string;
  workingDirectory: string;
  parentId: string | null;
  childrenIds: string[];
}

export interface OrchestrationEvents {
  'spawn-child': (parentId: string, command: SpawnChildCommand) => void;
  'message-child': (parentId: string, command: MessageChildCommand) => void;
  'terminate-child': (parentId: string, command: TerminateChildCommand) => void;
  'get-children': (parentId: string, callback: (children: ChildInfo[]) => void) => void;
  'get-child-output': (parentId: string, command: GetChildOutputCommand, callback: (output: string[]) => void) => void;
  'inject-response': (instanceId: string, response: string) => void;
}

export interface ChildInfo {
  id: string;
  name: string;
  status: string;
  createdAt: number;
}

export class OrchestrationHandler extends EventEmitter {
  private contexts: Map<string, OrchestrationContext> = new Map();

  /**
   * Register an instance for orchestration
   */
  registerInstance(
    instanceId: string,
    workingDirectory: string,
    parentId: string | null = null
  ): void {
    this.contexts.set(instanceId, {
      instanceId,
      workingDirectory,
      parentId,
      childrenIds: [],
    });
  }

  /**
   * Unregister an instance
   */
  unregisterInstance(instanceId: string): void {
    this.contexts.delete(instanceId);

    // Remove from parent's children list
    for (const ctx of this.contexts.values()) {
      ctx.childrenIds = ctx.childrenIds.filter((id) => id !== instanceId);
    }
  }

  /**
   * Add a child to a parent's context
   */
  addChild(parentId: string, childId: string): void {
    const ctx = this.contexts.get(parentId);
    if (ctx && !ctx.childrenIds.includes(childId)) {
      ctx.childrenIds.push(childId);
    }
  }

  /**
   * Get the orchestration prompt to prepend to the first message
   */
  getOrchestrationPrompt(instanceId: string): string {
    return generateOrchestrationPrompt(instanceId);
  }

  /**
   * Process output from an instance and execute any orchestrator commands
   */
  processOutput(instanceId: string, output: string): void {
    const commands = parseOrchestratorCommands(output);

    for (const command of commands) {
      this.executeCommand(instanceId, command);
    }
  }

  /**
   * Execute an orchestrator command
   */
  private executeCommand(instanceId: string, command: OrchestratorCommand): void {
    const ctx = this.contexts.get(instanceId);
    if (!ctx) {
      console.warn(`No orchestration context for instance ${instanceId}`);
      return;
    }

    console.log(`Orchestrator: Executing ${command.action} from instance ${instanceId}`);

    switch (command.action) {
      case 'spawn_child':
        this.handleSpawnChild(instanceId, command);
        break;

      case 'message_child':
        this.handleMessageChild(instanceId, command);
        break;

      case 'get_children':
        this.handleGetChildren(instanceId);
        break;

      case 'terminate_child':
        this.handleTerminateChild(instanceId, command);
        break;

      case 'get_child_output':
        this.handleGetChildOutput(instanceId, command);
        break;
    }
  }

  private handleSpawnChild(parentId: string, command: SpawnChildCommand): void {
    this.emit('spawn-child', parentId, command);
  }

  private handleMessageChild(parentId: string, command: MessageChildCommand): void {
    const ctx = this.contexts.get(parentId);
    if (!ctx) return;

    // Verify the child belongs to this parent
    if (!ctx.childrenIds.includes(command.childId)) {
      this.injectResponse(parentId, 'message_child', false, {
        error: `Child ${command.childId} not found or not owned by you`,
      });
      return;
    }

    this.emit('message-child', parentId, command);
  }

  private handleGetChildren(parentId: string): void {
    this.emit('get-children', parentId, (children: ChildInfo[]) => {
      this.injectResponse(parentId, 'get_children', true, { children });
    });
  }

  private handleTerminateChild(parentId: string, command: TerminateChildCommand): void {
    const ctx = this.contexts.get(parentId);
    if (!ctx) return;

    // Verify the child belongs to this parent
    if (!ctx.childrenIds.includes(command.childId)) {
      this.injectResponse(parentId, 'terminate_child', false, {
        error: `Child ${command.childId} not found or not owned by you`,
      });
      return;
    }

    this.emit('terminate-child', parentId, command);
  }

  private handleGetChildOutput(parentId: string, command: GetChildOutputCommand): void {
    const ctx = this.contexts.get(parentId);
    if (!ctx) return;

    // Verify the child belongs to this parent
    if (!ctx.childrenIds.includes(command.childId)) {
      this.injectResponse(parentId, 'get_child_output', false, {
        error: `Child ${command.childId} not found or not owned by you`,
      });
      return;
    }

    this.emit('get-child-output', parentId, command, (output: string[]) => {
      this.injectResponse(parentId, 'get_child_output', true, { output });
    });
  }

  /**
   * Send a response back to the instance
   */
  private injectResponse(
    instanceId: string,
    action: string,
    success: boolean,
    data: unknown
  ): void {
    const response = formatCommandResponse(action as any, success, data);
    this.emit('inject-response', instanceId, response);
  }

  /**
   * Notify parent about a successful child spawn
   */
  notifyChildSpawned(parentId: string, childId: string, childName: string): void {
    this.addChild(parentId, childId);
    this.injectResponse(parentId, 'spawn_child', true, {
      childId,
      name: childName,
      message: 'Child instance created successfully',
    });
  }

  /**
   * Notify parent about a successful message delivery
   */
  notifyMessageSent(parentId: string, childId: string): void {
    this.injectResponse(parentId, 'message_child', true, {
      childId,
      message: 'Message delivered successfully',
    });
  }

  /**
   * Notify parent about a child termination
   */
  notifyChildTerminated(parentId: string, childId: string): void {
    const ctx = this.contexts.get(parentId);
    if (ctx) {
      ctx.childrenIds = ctx.childrenIds.filter((id) => id !== childId);
    }
    this.injectResponse(parentId, 'terminate_child', true, {
      childId,
      message: 'Child instance terminated',
    });
  }

  /**
   * Notify an instance about an error
   */
  notifyError(instanceId: string, error: string): void {
    this.injectResponse(instanceId, 'error', false, {
      error,
      message: error,
    });
  }
}
