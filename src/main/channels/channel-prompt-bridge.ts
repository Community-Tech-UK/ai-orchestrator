/**
 * Channel Prompt Bridge
 *
 * Surfaces agent-driven approval and question prompts to the chat channels
 * (Discord / WhatsApp) that are actively watching an instance, and routes the
 * user's answer back to the waiting agent — the parity gap the mobile gateway
 * already closes via `instance:input-required` and `user-action-request`.
 *
 * Without this, an agent that asks "should I proceed?" or hits a permission
 * gate hangs silently: the channel user never sees the question and the agent
 * blocks forever. Here we:
 *   - post the question (with Approve / Deny / option buttons) to every channel
 *     chat currently streaming that instance's output,
 *   - resolve it when the user clicks a button (`/approve`, `/reject`,
 *     `/answer`) or replies in the same chat,
 *   - forward the decision to the same runtime seams the mobile gateway uses
 *     (`resumeAfterDeferredPermission` for permission gates,
 *     `orchestration.respondToUserAction` for user-action requests),
 *   - drop the pending prompt when the instance leaves a waiting status (the
 *     question was answered elsewhere — mobile, the renderer — or the turn
 *     moved on), so a later unrelated message is never mistaken for an answer.
 */

import { getLogger } from '../logging/logger';
import type { ChannelManager } from './channel-manager';
import type {
  ChannelMessageAction,
  ChannelPlatform,
  InboundChannelMessage,
} from '../../shared/types/channels';
import type { BaseChannelAdapter } from './channel-adapter';

const logger = getLogger('ChannelPromptBridge');

/** Statuses in which a pending prompt is legitimately still awaiting an answer. */
const WAITING_STATUSES = new Set<string>(['waiting_for_permission', 'waiting_for_input']);
/** Discord allows at most 5 buttons per action row; keep one spare. */
const MAX_OPTION_BUTTONS = 4;
const AFFIRMATIVE = new Set(['y', 'yes', 'ok', 'okay', 'approve', 'approved', 'allow', 'allowed', 'proceed', 'go', 'sure']);
const NEGATIVE = new Set(['n', 'no', 'deny', 'denied', 'reject', 'rejected', 'stop', 'cancel', 'nope']);

/** A channel chat currently relaying an instance's output. */
export interface WatchingChat {
  platform: ChannelPlatform;
  chatId: string;
  replyToMessageId?: string;
  isDM: boolean;
}

/** The subset of the InstanceManager the bridge needs. Structurally satisfied by the real manager. */
export interface PromptBridgeInstanceManager {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  resumeAfterDeferredPermission(
    instanceId: string,
    approved: boolean,
    updatedInput?: Record<string, unknown>,
  ): Promise<unknown>;
  clearPendingInputRequiredPermission(instanceId: string, requestId: string): void;
  getOrchestrationHandler(): PromptBridgeOrchestration;
}

export interface PromptBridgeOrchestration {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  respondToUserAction(requestId: string, approved: boolean, selectedOption?: string): void;
}

export interface ChannelPromptBridgeDeps {
  getInstanceManager: () => PromptBridgeInstanceManager;
  getChannelManager: () => ChannelManager;
  /** Chats currently streaming output for the given instance (the router's live trackers). */
  getWatchingChats: (instanceId: string) => WatchingChat[];
}

interface PromptOption {
  id: string;
  label: string;
}

interface PendingChannelPrompt {
  requestId: string;
  instanceId: string;
  kind: 'permission' | 'user-action';
  requestType?: string;
  platform: ChannelPlatform;
  /** Every chat the question was posted to (used to match a text reply). */
  chatIds: string[];
  /** Message ids of the posted questions, for post-resolution annotation. */
  postedMessages: { chatId: string; messageId: string }[];
  /** True when the agent is waiting for free-form text (ask_questions), not a yes/no. */
  expectsText: boolean;
  options?: PromptOption[];
  createdAt: number;
}

export class ChannelPromptBridge {
  private readonly prompts = new Map<string, PendingChannelPrompt>();
  private orchestration: PromptBridgeOrchestration | null = null;
  private started = false;

  private readonly onInputRequired = (payload: unknown): void => this.handleInputRequired(payload);
  private readonly onUserAction = (request: unknown): void => this.handleUserAction(request);
  private readonly onStateUpdate = (payload: unknown): void => this.handleStateUpdate(payload);

  constructor(private readonly deps: ChannelPromptBridgeDeps) {}

  /** Attach the persistent runtime listeners. Must run after the InstanceManager is injected. */
  start(): void {
    if (this.started) return;
    let im: PromptBridgeInstanceManager;
    try {
      im = this.deps.getInstanceManager();
    } catch (err) {
      logger.warn('Prompt bridge could not attach — instance manager unavailable', { error: String(err) });
      return;
    }
    im.on('instance:input-required', this.onInputRequired);
    im.on('instance:state-update', this.onStateUpdate);
    try {
      this.orchestration = im.getOrchestrationHandler();
      this.orchestration.on('user-action-request', this.onUserAction);
    } catch (err) {
      logger.warn('Prompt bridge could not attach orchestration listener', { error: String(err) });
    }
    this.started = true;
    logger.info('Channel prompt bridge started');
  }

  stop(): void {
    if (!this.started) return;
    try {
      const im = this.deps.getInstanceManager();
      im.removeListener('instance:input-required', this.onInputRequired);
      im.removeListener('instance:state-update', this.onStateUpdate);
    } catch {
      // Instance manager already gone; nothing to detach.
    }
    this.orchestration?.removeListener('user-action-request', this.onUserAction);
    this.orchestration = null;
    this.prompts.clear();
    this.started = false;
  }

  // ---------------------------------------------------------------------------
  // Inbound runtime events
  // ---------------------------------------------------------------------------

  private handleInputRequired(payload: unknown): void {
    const p = payload as {
      instanceId?: string;
      requestId?: string;
      prompt?: string;
      metadata?: Record<string, unknown>;
    };
    if (!p?.instanceId || !p?.requestId) return;
    if (this.prompts.has(p.requestId)) return;

    const watchers = this.deps.getWatchingChats(p.instanceId);
    if (watchers.length === 0) return; // No channel is watching — mobile/renderer handle it.

    const meta = p.metadata ?? {};
    const toolName =
      (typeof meta['tool_name'] === 'string' && meta['tool_name']) ||
      (typeof meta['toolName'] === 'string' && meta['toolName']) ||
      undefined;
    const title = toolName ? `**${toolName}** needs approval` : '**Permission required**';
    const detail = p.prompt?.trim() || (toolName ? `Allow \`${toolName}\` to run?` : 'An action needs your approval.');
    const body = `⚠️ ${title}\n${detail}\n\nReply **yes** / **no**, or use the buttons below.`;

    this.postPrompt(
      {
        requestId: p.requestId,
        instanceId: p.instanceId,
        kind: 'permission',
        expectsText: false,
      },
      watchers,
      body,
      this.approveDenyActions(p.requestId),
    );
  }

  private handleUserAction(request: unknown): void {
    const r = request as {
      id?: string;
      instanceId?: string;
      requestType?: unknown;
      title?: string;
      message?: string;
      options?: { id?: unknown; label?: unknown }[];
      questions?: unknown;
    };
    if (!r?.id || !r?.instanceId) return;
    if (this.prompts.has(r.id)) return;

    const watchers = this.deps.getWatchingChats(r.instanceId);
    if (watchers.length === 0) return;

    const requestType = typeof r.requestType === 'string' ? r.requestType : undefined;
    const options: PromptOption[] = Array.isArray(r.options)
      ? r.options
          .filter((o): o is { id: string; label: string } =>
            Boolean(o) && typeof o.id === 'string' && typeof o.label === 'string')
          .map((o) => ({ id: o.id, label: o.label }))
      : [];
    const questions = Array.isArray(r.questions)
      ? r.questions.filter((q): q is string => typeof q === 'string')
      : [];

    const title = r.title?.trim() || 'Input needed';
    const message = r.message?.trim() || 'An agent is waiting for your response.';
    const lines = [`❓ **${title}**`, message];

    let actions: ChannelMessageAction[] = [];
    let expectsText = false;

    if (options.length > 0) {
      lines.push('', 'Choose an option:');
      options.slice(0, MAX_OPTION_BUTTONS).forEach((o, i) => lines.push(`**${i + 1}.** ${o.label}`));
      actions = this.optionActions(r.id, options);
      if (options.length > MAX_OPTION_BUTTONS) {
        lines.push('', `Reply with the option name to pick beyond the first ${MAX_OPTION_BUTTONS}.`);
        expectsText = true;
      }
    } else if (questions.length > 0) {
      lines.push('', ...questions.map((q, i) => `**${i + 1}.** ${q}`), '', 'Reply here with your answer.');
      expectsText = true;
    } else {
      // A bare confirm / approve_action / switch_mode.
      lines.push('', 'Reply **yes** / **no**, or use the buttons below.');
      actions = this.approveDenyActions(r.id);
    }

    this.postPrompt(
      {
        requestId: r.id,
        instanceId: r.instanceId,
        kind: 'user-action',
        requestType,
        expectsText,
        options: options.length > 0 ? options : undefined,
      },
      watchers,
      lines.join('\n'),
      actions,
    );
  }

  private handleStateUpdate(payload: unknown): void {
    const u = payload as { instanceId?: string; status?: string };
    if (!u?.instanceId || !u?.status) return;
    if (WAITING_STATUSES.has(u.status)) return;
    // The instance moved out of a waiting status: any pending prompt for it was
    // answered elsewhere or superseded. Drop it so a later message in the same
    // chat isn't misread as an answer.
    this.clearForInstance(u.instanceId);
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve a pending prompt by request id. Returns `true` when a prompt was
   * pending and the decision was forwarded to the runtime; `false` when the
   * request is unknown or already answered.
   */
  async resolveByRequestId(
    requestId: string,
    approved: boolean,
    response?: string,
  ): Promise<boolean> {
    const prompt = this.prompts.get(requestId);
    if (!prompt) return false;
    this.prompts.delete(requestId);

    try {
      const im = this.deps.getInstanceManager();
      if (prompt.kind === 'user-action') {
        im.getOrchestrationHandler().respondToUserAction(requestId, approved, response);
      } else {
        await im.resumeAfterDeferredPermission(prompt.instanceId, approved);
        im.clearPendingInputRequiredPermission(prompt.instanceId, requestId);
      }
    } catch (err) {
      logger.error(
        'Failed to forward channel prompt decision',
        err instanceof Error ? err : new Error(String(err)),
      );
      return false;
    }

    void this.annotateResolved(prompt, approved, response);
    return true;
  }

  /**
   * If the user's plain message answers a prompt pending in this chat, forward
   * it and return `true`. Otherwise return `false` so the message routes
   * normally. Called by the router before it treats the message as a new turn.
   */
  async tryResolveTextReply(msg: InboundChannelMessage, adapter: BaseChannelAdapter): Promise<boolean> {
    const prompt = [...this.prompts.values()].find((p) => p.chatIds.includes(msg.chatId));
    if (!prompt) return false;

    const text = msg.content.trim();
    const lower = text.toLowerCase();

    // Option match by id or label (case-insensitive) for select_option prompts.
    if (prompt.options?.length) {
      const match = prompt.options.find(
        (o) => o.id.toLowerCase() === lower || o.label.toLowerCase() === lower,
      );
      if (match) {
        const ok = await this.resolveByRequestId(prompt.requestId, true, match.id);
        if (ok) await this.ackTextReply(msg, adapter, `Selected **${match.label}**.`);
        return ok;
      }
    }

    if (NEGATIVE.has(lower)) {
      const ok = await this.resolveByRequestId(prompt.requestId, false);
      if (ok) await this.ackTextReply(msg, adapter, 'Denied.');
      return ok;
    }

    if (prompt.expectsText) {
      const ok = await this.resolveByRequestId(prompt.requestId, true, text);
      if (ok) await this.ackTextReply(msg, adapter, 'Answer sent to the agent.');
      return ok;
    }

    if (AFFIRMATIVE.has(lower)) {
      const ok = await this.resolveByRequestId(prompt.requestId, true);
      if (ok) await this.ackTextReply(msg, adapter, 'Approved.');
      return ok;
    }

    // A permission / confirm prompt is pending but the message isn't a clear
    // yes/no; let it route normally rather than guess an approval.
    return false;
  }

  hasPendingPrompt(requestId: string): boolean {
    return this.prompts.has(requestId);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private postPrompt(
    base: Omit<PendingChannelPrompt, 'platform' | 'chatIds' | 'postedMessages' | 'createdAt'>,
    watchers: WatchingChat[],
    body: string,
    actions: ChannelMessageAction[],
  ): void {
    const chatIds = [...new Set(watchers.map((w) => w.chatId))];
    const record: PendingChannelPrompt = {
      ...base,
      platform: watchers[0].platform,
      chatIds,
      postedMessages: [],
      createdAt: Date.now(),
    };
    this.prompts.set(record.requestId, record);

    const cm = this.deps.getChannelManager();
    const postedChatIds = new Set<string>();
    for (const watcher of watchers) {
      if (postedChatIds.has(watcher.chatId)) continue;
      postedChatIds.add(watcher.chatId);
      const adapter = cm.getAdapter(watcher.platform);
      if (!adapter) continue;
      void adapter
        .sendMessage(watcher.chatId, body, { replyTo: watcher.replyToMessageId, actions })
        .then((sent) => {
          record.postedMessages.push({ chatId: watcher.chatId, messageId: sent.messageId });
        })
        .catch((err: unknown) => {
          logger.warn('Failed to post channel prompt', {
            instanceId: record.instanceId,
            error: String(err),
          });
        });
    }
  }

  private clearForInstance(instanceId: string): void {
    for (const [requestId, prompt] of this.prompts) {
      if (prompt.instanceId === instanceId) {
        this.prompts.delete(requestId);
      }
    }
  }

  private approveDenyActions(requestId: string): ChannelMessageAction[] {
    const encoded = encodeURIComponent(requestId);
    return [
      { id: `orch:approve:${encoded}`, label: 'Approve', style: 'success' },
      { id: `orch:reject:${encoded}`, label: 'Deny', style: 'danger' },
    ];
  }

  private optionActions(requestId: string, options: PromptOption[]): ChannelMessageAction[] {
    const encReq = encodeURIComponent(requestId);
    return options.slice(0, MAX_OPTION_BUTTONS).map((option) => ({
      id: `orch:answer:${encReq}~${encodeURIComponent(option.id)}`,
      label: option.label.slice(0, 80),
      style: 'primary' as const,
    }));
  }

  private async ackTextReply(
    msg: InboundChannelMessage,
    adapter: BaseChannelAdapter,
    text: string,
  ): Promise<void> {
    try {
      await adapter.sendMessage(msg.chatId, text, { replyTo: msg.messageId });
    } catch (err) {
      logger.warn('Failed to acknowledge prompt reply', { error: String(err) });
    }
  }

  private async annotateResolved(
    prompt: PendingChannelPrompt,
    approved: boolean,
    response?: string,
  ): Promise<void> {
    if (prompt.postedMessages.length === 0) return;
    const outcome = response
      ? `✅ Answered: ${response}`
      : approved
        ? '✅ Approved'
        : '🚫 Denied';
    const cm = this.deps.getChannelManager();
    const adapter = cm.getAdapter(prompt.platform);
    if (!adapter) return;
    for (const posted of prompt.postedMessages) {
      try {
        await adapter.editMessage(posted.chatId, posted.messageId, outcome);
      } catch {
        // Editing is best-effort; the runtime decision has already been made.
      }
    }
  }
}
