import type { OutputMessage } from '../../../shared/types/instance.types';
import type { InputFormatter } from '../input-formatter';
import { getLogger } from '../../logging/logger';
import { asUnknownRecord } from './claude-cli-adapter.types';
import { createOutputMessage, ndjsonSafeStringify } from './base-cli-adapter-utils';

const logger = getLogger('ClaudeElicitationCancel');

/**
 * Cancel the nested connector request observed in the October CLI probe.
 * This owns no approval state: other control subtypes remain with the adapter.
 * Never mirror the form, URL or prompt into a user message or an input card.
 */
export function handleClaudeElicitationCancel(
  message: unknown,
  formatter: Pick<InputFormatter, 'isWritable' | 'sendRaw'> | null,
  emitOutput: (output: OutputMessage) => void,
): boolean {
  const frame = asUnknownRecord(message);
  const request = asUnknownRecord(frame?.['request']);
  if (frame?.['type'] !== 'control_request' || request?.['subtype'] !== 'elicitation') return false;

  const requestId = frame['request_id'];
  if (typeof requestId !== 'string' || !requestId.trim()) {
    logger.warn('Cannot cancel connector elicitation without a correlation ID');
    return true;
  }

  const failed = (): void => {
    logger.warn('Could not deliver connector elicitation cancellation');
    emitOutput(createOutputMessage('error', "Claude's connector asked for input, but Harness could not send its cancellation."));
  };
  if (!formatter?.isWritable()) {
    failed();
    return true;
  }

  const serverName = typeof request['mcp_server_name'] === 'string'
    ? request['mcp_server_name'].replace(/\s+/g, ' ').trim().slice(0, 120) || 'MCP server'
    : 'MCP server';
  const reply = ndjsonSafeStringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { action: 'cancel' } },
  });
  void formatter.sendRaw(reply).then(() => {
    emitOutput(createOutputMessage('system',
      `Claude's connector ${serverName} asked for input and Harness declined it`,
      { metadata: { kind: 'mcp-elicitation-cancelled' } },
    ));
  }, failed);
  return true;
}
