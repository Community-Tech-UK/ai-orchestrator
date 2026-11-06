import type { ErrorInfo } from '../../shared/types/ipc.types';
import { presentError, type PresentedError } from '../../shared/present-error';
import { TURN_CONTINUATION_POLICY, type TurnNoticeAction } from './turn-ending-continuation-policy';

export interface ProcessCrashNotice {
  /** What the screen shows: plain words, no exit code or signal name. */
  message: string;
  /** The exit code or signal in the app's old words. For Details and hooks, never for the screen. */
  rawDetail: string;
  /** The one button the crash notice offers. */
  action: TurnNoticeAction | undefined;
  presentation: PresentedError;
}

/**
 * A session's process ended on its own and nothing restarted it. The exit code used to be
 * the whole message; now it is evidence kept beside a sentence that says what happened.
 * `sandboxAdvice` is already written for the user and arrives ready to follow a sentence ("". Hardened mode …").
 */
export function describeProcessCrash(
  provider: string,
  code: number | null,
  signal: string | null,
  sandboxAdvice = '',
): ProcessCrashNotice {
  const rawDetail = `Process exited unexpectedly with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`;
  const presentation = presentError({ code: 'provider-crash', message: rawDetail }, { provider });
  const advice = sandboxAdvice.replace(/^\.\s*/, '').trim();
  return {
    message: [presentation.headline, presentation.whatToDo, advice].filter(Boolean).join(' '),
    rawDetail,
    action: TURN_CONTINUATION_POLICY.crash.action,
    presentation,
  };
}

/** Preserve machine exit identity while keeping the visible reason and Details separate. */
export function buildProcessExitError(
  code: number | null,
  signal: string | null,
  reason: string,
  detail: string | undefined,
  redact: (text: string) => string,
): ErrorInfo {
  return {
    code: signal ? `SIGNAL_${signal}` : `EXIT_${code ?? 'unknown'}`,
    message: redact(reason),
    ...(detail ? { stack: redact(detail) } : {}),
    timestamp: Date.now(),
  };
}
