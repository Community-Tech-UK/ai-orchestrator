/**
 * Stable command signatures for orchestration-handler rate limiting.
 *
 * Extracted so the handler stays inside its LOC ceiling. Behaviour matches
 * the previous private method: same action + key parameters → same signature.
 */

import type { OrchestratorCommand } from './orchestration-protocol';

export function computeCommandSignature(command: OrchestratorCommand): string {
  switch (command.action) {
    case 'spawn_child':
      return `spawn_child:${command.task.slice(0, 100)}:${command.name || ''}:${command.provider || ''}:${command.model || ''}`;
    case 'message_child':
      return `message_child:${command.childId}:${command.message.slice(0, 80)}`;
    case 'terminate_child':
      return `terminate_child:${command.childId}`;
    case 'consensus_query':
      return `consensus_query:${command.question.slice(0, 100)}:${(command.providers || []).join(',')}`;
    case 'request_user_action':
      return `request_user_action:${command.requestType}:${command.title}`;
    case 'create_automation':
      // Dedup is recorded before the handler runs, so a refused command (8f cadence
      // reminder, invalid payload) must not shadow its corrected retry. Anything the
      // agent can change to fix a refusal is part of the signature: the literal
      // `confirmedByUser: true` and the whole automation body, not just name/prompt.
      return `create_automation:${command.confirmedByUser === true ? 'confirmed' : 'unconfirmed'}:${command.automation.name}:${JSON.stringify(command.automation)}`;
    case 'call_tool':
      return `call_tool:${command.toolId}:${JSON.stringify(command.args || '').slice(0, 80)}`;
    default:
      return `${command.action}:${JSON.stringify(command).slice(0, 120)}`;
  }
}
