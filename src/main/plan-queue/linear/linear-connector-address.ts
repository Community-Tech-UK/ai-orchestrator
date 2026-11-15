/**
 * Which connector is Linear's: decided by its address, never by its name. A pure function over a connector record, so
 * it can be checked again on every call. That re-check is what keeps the sign-in token on Linear's own address even if
 * someone later edits the connector to point somewhere else.
 */
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';
import type { LinearConnectorProblem } from './linear-errors';

export const LINEAR_CONNECTOR_HOST = 'mcp.linear.app';
/** The read-and-write address and the older streaming one, which Linear still serves. */
export const LINEAR_CONNECTOR_PATHS: readonly string[] = ['/mcp', '/sse'];
const LINEAR_READ_ONLY_PATH = '/mcp/readonly';

export type LinearRecordCheck =
  | { ok: true }
  | { ok: false; problem: LinearConnectorProblem; reason: string };

function refuse(problem: LinearConnectorProblem, reason: string): LinearRecordCheck {
  return { ok: false, problem, reason };
}

/** Whether the connector record may carry the Linear sign-in. The reason is fixed words, safe to show. */
export function checkLinearConnectorRecord(record: OrchestratorMcpServer): LinearRecordCheck {
  if (record.kind === 'local' || record.transport === 'stdio')
    return refuse('not-linear', 'A local program cannot be the Linear connector.');
  if (record.kind === 'microsoft365')
    return refuse('not-linear', 'A Microsoft 365 connector cannot be the Linear connector.');
  if (!record.autoConnect) return refuse('off', 'The connector is turned off.');
  if (record.authType !== 'oauth' && record.authType !== 'bearer')
    return refuse('not-linear', 'The connector has no sign-in set up.');
  let url: URL;
  try {
    url = new URL(record.url ?? '');
  } catch {
    return refuse('not-linear', 'The connector address is not a web address.');
  }
  if (url.protocol !== 'https:' || url.hostname !== LINEAR_CONNECTOR_HOST)
    return refuse('not-linear', 'The connector is not at Linear\'s own address.');
  if (url.username !== '' || url.password !== '' || url.port !== '' || url.search !== '' || url.hash !== '')
    return refuse('not-linear', 'The connector address has extra parts that Linear\'s own address does not.');
  if (url.pathname === LINEAR_READ_ONLY_PATH)
    return refuse(
      'read-only',
      'The connector uses Linear\'s read-only address. Harness needs the read and write address, https://mcp.linear.app/mcp.',
    );
  if (!LINEAR_CONNECTOR_PATHS.includes(url.pathname))
    return refuse('not-linear', 'The connector is not at Linear\'s own address.');
  return { ok: true };
}

export function isLinearConnectorRecord(record: OrchestratorMcpServer): boolean {
  return checkLinearConnectorRecord(record).ok;
}
