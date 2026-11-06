/**
 * Claude control channel (A8.0, Step 14a).
 *
 * One place that sends a Claude CLI control request and waits for its reply.
 * Owned by Step 14a; Phase 3's A7 builds `requestContextUsage()` on exactly
 * this API. The channel never rejects: every request resolves to
 * `{ok:true, payload}` or `{ok:false, code, message}`. Replies whose
 * `request_id` is unknown fall through to the adapter's own interrupt
 * matching, which is untouched.
 */

import { getLogger } from '../../logging/logger';
import { generateId } from '../../../shared/utils/id-generator';
import { errorDiagnostic } from '../../logging/source-diagnostics';

const logger = getLogger('ClaudeControlChannel');

export type ClaudeControlFailureCode =
  | 'timeout'
  | 'not-running'
  | 'cli-error'
  | 'cancelled'
  | 'process-exited';

export type ClaudeControlReply =
  | { ok: true; payload: Record<string, unknown> }
  | {
    ok: false;
    code: ClaudeControlFailureCode;
    message: string;
    /** The CLI's own `error_code` on an error reply, when it sends one. */
    errorCode?: string;
  };

export interface ClaudeControlWriter {
  sendControlRequest(
    subtype: string,
    requestId: string,
    fields?: Record<string, unknown>,
  ): Promise<void>;
  /** Writes `{type:'control_cancel_request', request_id}`; optional. */
  sendCancelControlRequest?(requestId: string): Promise<void>;
}

interface PendingControlRequest {
  resolve: (reply: ClaudeControlReply) => void;
  timer: ReturnType<typeof setTimeout>;
  writer: ClaudeControlWriter;
}

export class ClaudeControlChannel {
  private readonly pending = new Map<string, PendingControlRequest>();

  /**
   * Send one control request and wait for its reply. Never rejects.
   */
  async request(
    writer: ClaudeControlWriter,
    subtype: string,
    fields: Record<string, unknown>,
    options: { timeoutMs: number },
  ): Promise<ClaudeControlReply> {
    const requestId = `ctl_${generateId()}`;
    return new Promise<ClaudeControlReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          ok: false,
          code: 'timeout',
          message: `The CLI did not answer the ${subtype} request in time.`,
        });
      }, options.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, timer, writer });

      writer.sendControlRequest(subtype, requestId, fields).catch((err: unknown) => {
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        clearTimeout(entry.timer);
        logger.warn('Claude control request write failed', { subtype, ...errorDiagnostic(err) });
        resolve({
          ok: false,
          code: 'not-running',
          message: 'This session is not running right now.',
        });
      });
    });
  }

  /**
   * Settle a `control_response` when its `request_id` is one of ours. Returns
   * false for unknown ids so the adapter's interrupt matching still runs.
   */
  handleResponse(raw: Record<string, unknown>): boolean {
    // Real wire shape (Claude Code 2.1.303, confirmed against its own SDK
    // client): `{type:'control_response', response:{subtype, request_id,
    // response:<data>}}`. The outer `response` is the reply envelope; the data
    // the caller asked for (`title`, `applied`, the side-question text) sits one
    // level deeper, in the envelope's own `response`. A flat envelope with no
    // wrapper is still correlated by `request_id`.
    const nested = raw['response'];
    const response: Record<string, unknown> =
      nested !== null && typeof nested === 'object' && !Array.isArray(nested)
        ? (nested as Record<string, unknown>)
        : raw;
    const requestId = (response['request_id'] ?? raw['request_id']) as string | undefined;
    if (!requestId) return false;
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);

    const subtype = response['subtype'] ?? raw['subtype'];
    if (subtype === 'error' || response['ok'] === false) {
      const errorText = (response['error'] ?? response['message'] ?? 'The CLI refused the request.') as string;
      // Real error reply (2.1.303): `{subtype:'error', request_id, error,
      // error_code?}`; `error_code` is a string and is absent for some errors.
      const errorCode = response['error_code'];
      entry.resolve({
        ok: false, code: 'cli-error', message: String(errorText),
        ...(typeof errorCode === 'string' && errorCode ? { errorCode } : {}),
      });
      return true;
    }
    // Success: resolve the data object. Subtypes such as `set_model` reply with
    // no data, which resolves as an empty payload rather than the envelope.
    const data = response === raw ? undefined : response['response'];
    entry.resolve({
      ok: true,
      payload: data !== null && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {},
    });
    return true;
  }

  /** Resolve every pending request as failed (process exit). */
  failAll(code: ClaudeControlFailureCode, message = 'The Claude process exited before replying.'): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code, message });
    }
    this.pending.clear();
  }

  /**
   * Cancel one pending request, telling the CLI through
   * `control_cancel_request` (best-effort; a timeout covers a CLI that
   * ignores it).
   */
  cancel(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, code: 'cancelled', message: 'The request was cancelled.' });
    void entry.writer.sendCancelControlRequest?.(requestId).catch(() => undefined);
  }
}
