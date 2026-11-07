import { generateId } from '../../../shared/utils/id-generator';
import { isAdapterOnLoan } from '../../instance/lifecycle/adapter-loan-registry';
import { getLogger } from '../../logging/logger';
import { HARNESS_DENY_PREFIX, HARNESS_INTERACTIVE_DENY } from './claude-permission-response';
import { describeLiveAsk } from './describe-live-ask';

const logger = getLogger('ClaudeLivePermissionBroker');
export interface LivePermissionAnswer {
  approved: boolean;
  updatedInput?: Record<string, unknown>;
  note?: string;
}
export interface ClaudeLivePermissionHost {
  emit(event: string, payload: unknown): boolean;
  sendRawControl(message: Record<string, unknown>): Promise<void>;
}
interface PendingAsk {
  cardId: string;
  controlId: string;
  input: Record<string, unknown>;
  answering: boolean;
  completion?: Promise<void>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const MAX_CLOSED_CARDS = 256;

/** One broker per CLI process; no permission rules or restart/retry authority. */
export class ClaudeLivePermissionBroker {
  private readonly pending = new Map<string, PendingAsk>();
  /** Card ids this broker minted and already answered or withdrawn (FIFO, bounded). */
  private readonly closedCards = new Set<string>();
  constructor(private readonly host: ClaudeLivePermissionHost, private readonly instanceId?: () => string | undefined) {}

  handle(type: string, raw: unknown): boolean {
    if (!record(raw)) return false;
    if (type === 'control_cancel_request') {
      const ask = this.pending.get(String(raw['request_id']));
      if (ask) this.withdraw(ask, 'cancelled');
      return true;
    }
    if (type !== 'control_request' || !record(raw['request']) || raw['request']['subtype'] !== 'can_use_tool') return false;
    const controlId = typeof raw['request_id'] === 'string' ? raw['request_id'] : '';
    if (this.pending.has(controlId)) return true;
    let ask: PendingAsk | undefined;
    try {
      const request = raw['request'];
      const toolName = request['tool_name'];
      const input = request['input'];
      if (!controlId || typeof toolName !== 'string' || !toolName || !record(input)) throw new Error('Invalid permission envelope');
      const id = this.instanceId?.();
      if (id && isAdapterOnLoan(id)) {
        void this.reply(controlId, { behavior: 'deny', message: HARNESS_DENY_PREFIX
          + 'No person is watching this loop round, so this call was not made. Carry on without it or try another way.' }).catch(() => undefined);
        return true;
      }
      if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') {
        void this.reply(controlId, { behavior: 'deny', message: HARNESS_INTERACTIVE_DENY }).catch(() => undefined);
        return true;
      }
      ask = { cardId: generateId(), controlId, input, answering: false };
      this.pending.set(controlId, ask);
      const prompt = describeLiveAsk(toolName, input, typeof request['agent_id'] === 'string' ? request['agent_id'] : undefined);
      this.host.emit('status', 'waiting_for_permission');
      this.host.emit('output', { id: generateId(), timestamp: Date.now(), type: 'system', content: prompt,
        metadata: { permissionRequest: true, live: true } });
      this.host.emit('input_required', { id: ask.cardId, prompt, timestamp: Date.now(), metadata: {
        type: 'deferred_permission', live: true, tool_name: toolName, tool_input: input,
        tool_use_id: request['tool_use_id'], control_request_id: controlId, agent_id: request['agent_id'],
        blocked_path: request['blocked_path'], traceStage: 'adapter:claude-live-permission',
      } });
    } catch {
      if (ask) this.withdraw(ask, 'exited');
      void this.failClosed(controlId);
    }
    return true;
  }

  hasPending(): boolean { return this.pending.size > 0; }
  /** True for a card id this broker minted, live or closed. A closed card is never answerable again. */
  knowsCard(cardId: string): boolean {
    for (const ask of this.pending.values()) if (ask.cardId === cardId) return true;
    return this.closedCards.has(cardId);
  }
  private rememberClosedCard(cardId: string): void {
    this.closedCards.add(cardId);
    while (this.closedCards.size > MAX_CLOSED_CARDS) {
      const oldest = this.closedCards.values().next().value;
      if (oldest === undefined) return;
      this.closedCards.delete(oldest);
    }
  }
  /** Only the id-less legacy path may select the sole pending ask. An unknown id never selects another ask. */
  answer(cardId: string | undefined, answer: LivePermissionAnswer): boolean {
    const ask = cardId === undefined && this.pending.size === 1 ? this.pending.values().next().value
      : [...this.pending.values()].find(item => item.cardId === cardId);
    if (!ask || ask.answering) return false;
    ask.answering = true;
    ask.completion = this.reply(ask.controlId, answer.approved
      ? { behavior: 'allow', updatedInput: answer.updatedInput ?? ask.input }
      : { behavior: 'deny', message: HARNESS_DENY_PREFIX + (answer.note?.trim() || 'Continue without this call or try another way.') })
      .then(() => {
        if (this.pending.get(ask.controlId) !== ask) throw new Error('Live permission request was withdrawn');
        this.finishAnswer(ask, 'decided');
      }, () => {
        this.finishAnswer(ask, 'exited');
        throw new Error('Live permission reply could not be delivered');
      });
    // Direct protocol consumers may use only the boolean; lifecycle consumers await whenAnswered.
    void ask.completion.catch(() => undefined);
    return true;
  }

  whenAnswered(cardId: string | undefined): Promise<void> {
    const ask = cardId === undefined && this.pending.size === 1 ? this.pending.values().next().value
      : [...this.pending.values()].find(item => item.cardId === cardId);
    return ask?.completion ?? Promise.resolve();
  }

  private finishAnswer(ask: PendingAsk, reason: 'decided' | 'exited'): void {
    if (this.pending.get(ask.controlId) !== ask) return;
    this.pending.delete(ask.controlId);
    this.rememberClosedCard(ask.cardId);
    try {
      this.host.emit('input_required_resolved', { id: ask.cardId, reason });
      if (reason === 'decided' && !this.hasPending()) this.host.emit('status', 'busy');
    } catch { logger.error('Unable to publish live permission resolution'); }
  }

  dropAll(reason: 'cancelled' | 'exited'): void {
    for (const ask of this.pending.values()) this.withdraw(ask, reason);
  }

  private withdraw(ask: PendingAsk, reason: 'cancelled' | 'exited'): void {
    this.pending.delete(ask.controlId);
    this.rememberClosedCard(ask.cardId);
    try { this.host.emit('input_required_resolved', { id: ask.cardId, reason }); }
    catch { logger.error('Unable to publish live permission withdrawal'); }
  }

  private async reply(controlId: string, response: Record<string, unknown>): Promise<void> {
    try {
      await this.host.sendRawControl({ type: 'control_response', response: { subtype: 'success', request_id: controlId, response } });
    } catch {
      await this.failClosed(controlId);
      throw new Error('Live permission reply could not be delivered');
    }
  }

  private async failClosed(controlId: string): Promise<void> {
    // No raw request, input or thrown exception text: permission inputs may hold credentials.
    logger.warn('Live permission request failed closed');
    try {
      await this.host.sendRawControl({ type: 'control_response', response: {
        subtype: 'error', request_id: controlId, error: 'Harness could not handle this permission request; the call was declined.',
      } });
    } catch { logger.error('Unable to write live permission refusal'); }
  }
}
