import { getLogger } from '../logging/logger';
import { capForLog } from './pair-both-rendezvous-helpers';

const logger = getLogger('PairBoth');

/** The part of a pairing session a log line may carry: its id and status, nothing secret. */
interface LoggedSession {
  sessionId: string;
  status: string;
}

type Fields = Record<string, unknown>;

/**
 * Pair-both log lines. Each carries the session id and status when a session is
 * known. Never pass keys, tokens, codes or payloads in `fields`; text that came
 * from the other computer goes through `capForLog` first.
 */
export const pairBothLog = {
  info(message: string, session?: LoggedSession | null, fields: Fields = {}): void {
    logger.info(message, withSession(session, fields));
  },
  warn(message: string, session?: LoggedSession | null, fields: Fields = {}): void {
    logger.warn(message, withSession(session, fields));
  },
  /** A socket closing: the peer's close reason is capped. */
  closed(message: string, session: LoggedSession | null | undefined, code: number, reason: Buffer, fields: Fields): void {
    logger.info(message, withSession(session, { ...fields, code, reason: capForLog(reason.toString('utf8')) }));
  },
};

function withSession(session: LoggedSession | null | undefined, fields: Fields): Fields {
  return session ? { sessionId: session.sessionId, status: session.status, ...fields } : fields;
}
