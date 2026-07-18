import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  isRendererEventSchemaRegistered,
  sendValidatedRendererEvent,
  validateRendererEventPayload,
} from './renderer-event-validation';

describe('renderer event validation', () => {
  it('registers the existing canonical event schemas', () => {
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.PROVIDER_RUNTIME_EVENT)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.DOC_REVIEW_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.VOICE_LOCAL_STT_EVENT)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.REMOTE_NODE_NODES_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.INSTANCE_CREATED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.INSTANCE_REMOVED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.INSTANCE_STATE_UPDATE)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.INSTANCE_BATCH_UPDATE)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.INSTANCE_QUEUE_INITIAL_PROMPT)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.PROMPT_HISTORY_DELTA)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.PAUSE_STATE_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.CONTEXT_EVIDENCE_STATE_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.VERIFICATION_AGENT_START)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.VERIFICATION_AGENT_STREAM)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.VERIFICATION_AGENT_COMPLETE)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.VERIFICATION_AGENT_ERROR)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.VERIFICATION_ROUND_PROGRESS)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.VERIFICATION_CONSENSUS_UPDATE)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.VERIFICATION_COMPLETE)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.VERIFICATION_ERROR)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.VERIFICATION_VERDICT_READY)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.AUTOMATION_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.AUTOMATION_RUN_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.MEMORY_STATS_UPDATE)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.MEMORY_WARNING)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.MEMORY_CRITICAL)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.RLM_STORE_UPDATED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.RLM_SECTION_ADDED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.RLM_SECTION_REMOVED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.RLM_QUERY_COMPLETE)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.TERMINAL_OUTPUT)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.TERMINAL_EXIT)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.TERMINAL_SPAWNED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.QUOTA_UPDATED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.QUOTA_WARNING)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.QUOTA_PACING_WARNING)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.QUOTA_EXHAUSTED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.COST_USAGE_RECORDED)).toBe(true);
    expect(isRendererEventSchemaRegistered('cost:budget-warning')).toBe(true);
    expect(isRendererEventSchemaRegistered('cost:budget-exceeded')).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.CODEBASE_INDEX_PROGRESS)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.CODEBASE_WATCHER_CHANGES)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.CODEBASE_AUTO_STATUS_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.APP_STARTUP_CAPABILITIES)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.CLI_UPDATE_PILL_DELTA)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.UPDATE_STATUS_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.MENU_NEW_INSTANCE)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.MENU_OPEN_SETTINGS)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.SETTINGS_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.TODO_LIST_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.NOTIFICATION_DELTA)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.RLM_STORAGE_MAINTENANCE_PROGRESS)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.WATCHER_FILE_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.WATCHER_ERROR)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.CONTEXT_WARNING)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.INSTANCE_COMPACT_STATUS)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.PLUGINS_LOADED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.PLUGINS_UNLOADED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.PLUGINS_ERROR)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.MODELS_CATALOG_UPDATED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.MODELS_LOCAL_MODEL_INVENTORY_UPDATED)).toBe(true);
    expect(isRendererEventSchemaRegistered('remote-config:updated')).toBe(true);
    expect(isRendererEventSchemaRegistered('remote-config:error')).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.REMOTE_NODE_EVENT)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.REMOTE_FS_EVENT)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.CAMPAIGN_STATE_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.CHANNEL_STATUS_CHANGED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.CHANNEL_MESSAGE_RECEIVED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.CHANNEL_RESPONSE_SENT)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.CHANNEL_ERROR)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.KG_EVENT_FACT_ADDED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.KG_EVENT_FACT_INVALIDATED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.CONVO_EVENT_IMPORT_COMPLETE)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.WAKE_EVENT_HINT_ADDED)).toBe(true);
    expect(isRendererEventSchemaRegistered(IPC_CHANNELS.WAKE_EVENT_CONTEXT_GENERATED)).toBe(true);
  });

  it('validates knowledge, conversation-mining, and wake-context events', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.KG_EVENT_FACT_ADDED, {
      tripleId: 'triple-1',
      subject: 'Harness',
      predicate: 'uses',
      object: 'Electron',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.KG_EVENT_FACT_INVALIDATED, {
      subject: 'Harness',
      predicate: 'uses',
      object: 'Old runtime',
      ended: '2026-07-17',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.CONVO_EVENT_IMPORT_COMPLETE, {
      sourceFile: '/repo/conversation.jsonl',
      segmentsCreated: 12,
      format: 'claude-code-jsonl',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.WAKE_EVENT_HINT_ADDED, {
      id: 'hint-1',
      content: 'Run targeted tests first',
      importance: 8,
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.WAKE_EVENT_CONTEXT_GENERATED, {
      totalTokens: 640,
      wing: '/repo',
    })).toBe(true);

    expect(validateRendererEventPayload(IPC_CHANNELS.CONVO_EVENT_IMPORT_COMPLETE, {
      sourceFile: '/repo/conversation.jsonl',
      segmentsCreated: -1,
      format: 'invented-format',
    })).toBe(false);
    expect(validateRendererEventPayload(IPC_CHANNELS.WAKE_EVENT_CONTEXT_GENERATED, {
      totalTokens: -1,
    })).toBe(false);
  });

  it('validates communication channel event payloads', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.CHANNEL_STATUS_CHANGED, {
      platform: 'whatsapp',
      status: 'connecting',
      qrCode: 'qr-data',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.CHANNEL_MESSAGE_RECEIVED, {
      id: 'inbound-1',
      platform: 'discord',
      chatId: 'chat-1',
      messageId: 'message-1',
      senderId: 'sender-1',
      senderName: 'James',
      content: 'Run the checks',
      attachments: [],
      isGroup: false,
      isDM: true,
      timestamp: 123,
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.CHANNEL_RESPONSE_SENT, {
      channelMessageId: 'outbound-1',
      platform: 'discord',
      chatId: 'chat-1',
      messageId: 'message-2',
      instanceId: 'instance-1',
      content: 'Checks passed',
      status: 'complete',
      timestamp: 124,
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.CHANNEL_ERROR, {
      platform: 'discord',
      error: 'connection lost',
      recoverable: true,
    })).toBe(true);

    expect(validateRendererEventPayload(IPC_CHANNELS.CHANNEL_MESSAGE_RECEIVED, {
      platform: 'email',
      content: 'missing message identity',
    })).toBe(false);
    expect(validateRendererEventPayload(IPC_CHANNELS.CHANNEL_ERROR, {
      platform: 'discord',
      error: 'missing recoverable flag',
    })).toBe(false);
  });

  it('validates campaign state event variants and their attached campaign DTO', () => {
    const campaign = {
      id: 'campaign-1',
      spec: {
        id: 'campaign-1',
        title: 'Release campaign',
        nodes: [{
          id: 'build',
          loopConfig: {
            initialPrompt: 'Build the release',
            workspaceCwd: '/repo',
          },
          dependsOn: [],
        }],
        edges: [],
        policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 1 },
        createdAt: 123,
      },
      status: 'running',
      nodeRuns: [{
        nodeId: 'build',
        campaignId: 'campaign-1',
        status: 'running',
        loopRunId: 'loop-1',
        startedAt: 124,
      }],
      startedAt: 123,
    };

    expect(validateRendererEventPayload(IPC_CHANNELS.CAMPAIGN_STATE_CHANGED, {
      event: 'campaign:started',
      data: { campaignId: 'campaign-1' },
      campaignId: 'campaign-1',
      campaign,
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.CAMPAIGN_STATE_CHANGED, {
      event: 'campaign:node-terminal',
      data: { campaignId: 'campaign-1', nodeId: 'build', status: 'completed' },
      campaignId: 'campaign-1',
      campaign: {
        ...campaign,
        status: 'completed',
        nodeRuns: [{
          ...campaign.nodeRuns[0],
          status: 'completed',
          endedAt: 125,
        }],
        endedAt: 125,
      },
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.CAMPAIGN_STATE_CHANGED, {
      event: 'campaign:node-terminal',
      data: { campaignId: 'campaign-1', nodeId: 'build' },
      campaignId: 'campaign-1',
      campaign,
    })).toBe(false);
    expect(validateRendererEventPayload(IPC_CHANNELS.CAMPAIGN_STATE_CHANGED, {
      event: 'campaign:invented',
      data: { campaignId: 'campaign-1' },
      campaignId: 'campaign-1',
      campaign,
    })).toBe(false);
  });

  it('validates remote node and filesystem event variants', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.REMOTE_NODE_EVENT, {
      type: 'connected',
      node: {
        id: 'node-1',
        name: 'Build worker',
        status: 'connected',
        activeInstances: 0,
        capabilities: {
          platform: 'linux',
          arch: 'x64',
          cpuCores: 8,
          totalMemoryMB: 16_384,
          availableMemoryMB: 8_192,
          supportedClis: ['codex'],
          hasBrowserRuntime: false,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: true,
          maxConcurrentInstances: 4,
          workingDirectories: ['/repo'],
          browsableRoots: ['/repo'],
          discoveredProjects: [],
        },
      },
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.REMOTE_NODE_EVENT, {
      type: 'disconnected',
      nodeId: 'node-1',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.REMOTE_NODE_EVENT, {
      type: 'flap-storm',
      nodeId: 'node-1',
      nodeName: 'Build worker',
      replacesInWindow: 4,
      windowMs: 30_000,
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.REMOTE_FS_EVENT, {
      nodeId: 'node-1',
      watchId: 'watch-1',
      events: [{ type: 'change', path: '/repo/a.ts', isDirectory: false }],
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.REMOTE_FS_EVENT, {
      nodeId: 'node-1',
      events: [{ type: 'renamed', path: '/repo/a.ts', isDirectory: false }],
    })).toBe(false);
  });

  it('validates remote-config update and error events', () => {
    expect(validateRendererEventPayload('remote-config:updated', {
      provider: 'codex',
      nested: { enabled: true },
    })).toBe(true);
    expect(validateRendererEventPayload('remote-config:error', {
      message: 'fetch failed',
    })).toBe(true);
    expect(validateRendererEventPayload('remote-config:error', {
      error: 'wrong field',
    })).toBe(false);
  });

  it('validates plugin and model-catalog event payloads', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.PLUGINS_ERROR, {
      pluginId: 'plugin-1',
      error: 'failed to load',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.MODELS_CATALOG_UPDATED, {
      totalEntries: 12,
      sources: ['static', 'models-dev'],
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.MODELS_LOCAL_MODEL_INVENTORY_UPDATED, {
      models: [{
        selectorId: 'lm://this-device/ollama/llama3',
        source: 'this-device',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'llama3',
        displayName: 'llama3 on This device',
        healthy: true,
        loaded: false,
        capabilities: {
          streaming: true,
          multiTurn: true,
          toolUse: 'none',
          vision: 'unknown',
        },
        discoveredAt: 123,
      }],
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.MODELS_CATALOG_UPDATED, {
      totalEntries: -1,
      sources: ['invented-source'],
    })).toBe(false);
  });

  it('accepts both context warning producers and rejects incomplete warnings', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.CONTEXT_WARNING, {
      instanceId: 'instance-1',
      percentage: 82,
      level: 'critical',
      deprecated: true,
      legacyThreshold: 80,
      decisionOwner: 'ContextSafetyPolicy',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.CONTEXT_WARNING, {
      instanceId: 'instance-1',
      allowed: false,
      shouldWarn: true,
      remainingTokens: 12_000,
      source: 'default',
      message: 'Context window is too small',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.CONTEXT_WARNING, {
      instanceId: 'instance-1',
      shouldWarn: true,
    })).toBe(false);
  });

  it('validates compaction lifecycle event variants', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.INSTANCE_COMPACT_STATUS, {
      instanceId: 'instance-1',
      status: 'started',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.INSTANCE_COMPACT_STATUS, {
      instanceId: 'instance-1',
      status: 'completed',
      success: true,
      method: 'native',
      blocking: true,
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.INSTANCE_COMPACT_STATUS, {
      instanceId: 'instance-1',
      status: 'error',
      error: 'compaction failed',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.INSTANCE_COMPACT_STATUS, {
      instanceId: 'instance-1',
      status: 'completed',
    })).toBe(false);
  });

  it('validates automation change event discriminators', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.AUTOMATION_CHANGED, {
      automation: null,
      automationId: 'automation-1',
      type: 'deleted',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.AUTOMATION_CHANGED, {
      automation: null,
      automationId: 'automation-1',
      type: 'renamed',
    })).toBe(false);
  });

  it('rejects malformed verification streaming events', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.VERIFICATION_AGENT_STREAM, {
      sessionId: 'verification-1',
      agentId: 'agent-1',
      chunk: 'partial response',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.VERIFICATION_AGENT_STREAM, {
      sessionId: 'verification-1',
      chunk: 'missing agent id',
    })).toBe(false);
  });

  it('validates the core instance lifecycle event shapes', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.INSTANCE_CREATED, {
      id: 'instance-1',
      status: 'initializing',
      workingDirectory: '/repo',
      displayName: 'Build task',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.INSTANCE_REMOVED, 'instance-1')).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.INSTANCE_STATE_UPDATE, {
      instanceId: 'instance-1',
      status: 'waiting_for_input',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.INSTANCE_BATCH_UPDATE, {
      updates: [{ instanceId: 'instance-1', status: 'idle' }],
      timestamp: 123,
    })).toBe(true);

    expect(validateRendererEventPayload(IPC_CHANNELS.INSTANCE_CREATED, {
      id: 'instance-1',
      status: 'not-a-real-status',
      workingDirectory: '/repo',
    })).toBe(false);
    expect(validateRendererEventPayload(IPC_CHANNELS.INSTANCE_BATCH_UPDATE, {
      updates: [{ status: 'idle' }],
      timestamp: 123,
    })).toBe(false);
  });

  it('accepts a valid registered event and rejects an invalid one', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.VOICE_LOCAL_STT_EVENT, {
      sessionId: 'voice-session-1',
      kind: 'final',
      text: 'hello',
      segmentId: 1,
    })).toBe(true);

    expect(validateRendererEventPayload(IPC_CHANNELS.VOICE_LOCAL_STT_EVENT, {
      kind: 'final',
      text: 'missing session id',
    })).toBe(false);
  });

  it('validates loop lifecycle event payloads', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.LOOP_STARTED, {
      loopRunId: 'loop-1',
      chatId: 'chat-1',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.LOOP_STATE_CHANGED, {
      loopRunId: 'loop-1',
      state: { id: 'loop-1', chatId: 'chat-1', status: 'running', config: {}, totalIterations: 3 },
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.LOOP_ACTIVITY, {
      loopRunId: 'loop-1',
      seq: 2,
      stage: 'IMPLEMENT',
      timestamp: 123,
      kind: 'status',
      message: 'Circuit breaker open',
      detail: { reason: 'circuit-breaker-open' },
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.LOOP_PAUSED_NO_PROGRESS, {
      loopRunId: 'loop-1',
      signal: { id: 'BLOCKED', verdict: 'CRITICAL', message: 'BLOCKED.md present' },
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.LOOP_PROVIDER_LIMIT, {
      loopRunId: 'loop-1',
      reason: 'usage limit',
      source: 'quota',
      action: 'parked',
      resumeAt: null,
      willResume: false,
    })).toBe(true);

    expect(validateRendererEventPayload(IPC_CHANNELS.LOOP_STATE_CHANGED, {
      loopRunId: 'loop-1',
      state: { id: 'loop-1', chatId: 'chat-1', status: 'invented-status' },
    })).toBe(false);
    expect(validateRendererEventPayload(IPC_CHANNELS.LOOP_ITERATION_COMPLETE, {
      loopRunId: 'loop-1',
      seq: 1,
      verdict: 'MAYBE',
    })).toBe(false);
  });

  it('validates CLI verification coordinator event payloads', () => {
    expect(validateRendererEventPayload('verification:started', {
      requestId: 'cli-verify-1',
      agents: ['Claude', 'Codex'],
    })).toBe(true);
    expect(validateRendererEventPayload('verification:cancelled', {
      sessionId: 'cli-verify-1',
      reason: 'User requested cancellation',
      agentsCancelled: 2,
    })).toBe(true);
    expect(validateRendererEventPayload('verification:agent-cancelled', {
      sessionId: 'cli-verify-1',
      agentId: 'agent-1',
    })).toBe(true);
    expect(validateRendererEventPayload('verification:warning', {
      message: 'Only 2 agents available. Byzantine tolerance requires 3+.',
      available: ['Claude', 'Codex'],
    })).toBe(true);

    expect(validateRendererEventPayload('verification:started', {
      requestId: 'cli-verify-1',
      agents: [{ name: 'Claude' }],
    })).toBe(false);
  });

  it('validates reaction, orchestration activity, and user-action events', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.REACTION_EVENT, {
      id: 'reaction-1',
      type: 'ci.failing',
      priority: 'action',
      instanceId: 'instance-1',
      timestamp: 123,
      data: { ciStatus: 'failing' },
      message: 'CI failing',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.ORCHESTRATION_ACTIVITY, {
      instanceId: 'instance-1',
      activity: 'Debate round 2 of 3',
      category: 'debate',
      progress: { current: 2, total: 3 },
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.USER_ACTION_REQUEST, {
      id: 'request-1',
      instanceId: 'instance-1',
      requestType: 'select_option',
      title: 'Pick a branch',
      message: 'Which branch should be merged?',
      options: [{ id: 'a', label: 'main' }],
      createdAt: 123,
    })).toBe(true);

    expect(validateRendererEventPayload(IPC_CHANNELS.REACTION_EVENT, {
      id: 'reaction-1',
      type: 'ci.failing',
      priority: 'catastrophic',
      instanceId: 'instance-1',
      timestamp: 123,
      data: {},
    })).toBe(false);
    expect(validateRendererEventPayload(IPC_CHANNELS.USER_ACTION_REQUEST, {
      id: 'request-1',
      instanceId: 'instance-1',
      requestType: 'invented',
      title: 'x',
      message: 'y',
      createdAt: 123,
    })).toBe(false);
  });

  it('validates cross-model review, doom-loop, and input-required events', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.CROSS_MODEL_REVIEW_STARTED, {
      instanceId: 'instance-1',
      reviewId: 'review-1',
      reviewStartedAt: 123,
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.CROSS_MODEL_REVIEW_RESULT, {
      id: 'review-1',
      instanceId: 'instance-1',
      outputType: 'code',
      reviewDepth: 'structured',
      reviews: [{ reviewerId: 'codex', overallVerdict: 'approve', parseSuccess: true }],
      hasDisagreement: false,
      timestamp: 124,
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.CROSS_MODEL_REVIEW_REVIEWER_UNAVAILABLE, {
      dropped: [{ cli: 'gemini', error: 'not detected on PATH' }],
    })).toBe(true);
    expect(validateRendererEventPayload('instance:doom-loop', {
      instanceId: 'instance-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      consecutiveCount: 5,
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.INPUT_REQUIRED, {
      instanceId: 'instance-1',
      requestId: 'request-1',
      prompt: 'Approve this tool call?',
      timestamp: 123,
      metadata: { toolName: 'Bash' },
    })).toBe(true);

    expect(validateRendererEventPayload(IPC_CHANNELS.CROSS_MODEL_REVIEW_RESULT, {
      id: 'review-1',
      instanceId: 'instance-1',
      outputType: 'poetry',
      reviewDepth: 'structured',
      reviews: [],
      hasDisagreement: false,
      timestamp: 124,
    })).toBe(false);
  });

  it('validates mcp and vcs event payloads', () => {
    expect(validateRendererEventPayload(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED, {
      serverId: 'server-1',
      status: 'connecting',
      phase: 'discover',
      phaseState: 'running',
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.MCP_STATE_CHANGED, { type: 'tools' })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.MCP_MULTI_PROVIDER_STATE_CHANGED, {
      orchestrator: [{
        record: {
          id: 'server-1',
          name: 'codemem',
          scope: 'orchestrator',
          transport: 'stdio',
          autoConnect: true,
          readOnly: false,
          createdAt: 1,
          updatedAt: 2,
        },
        injectInto: ['claude'],
      }],
      shared: [],
      providers: [{ provider: 'codex', cliAvailable: true, servers: [] }],
      stateVersion: 7,
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.VCS_STATUS_CHANGED, {
      repoPath: '/repo',
      reason: 'index',
      timestamp: 123,
    })).toBe(true);
    expect(validateRendererEventPayload(IPC_CHANNELS.VCS_OPERATION_PROGRESS, {
      opId: 'op-1',
      kind: 'push',
      phase: 'completed',
      repoPath: '/repo',
      durationMs: 1200,
      exitCode: 0,
    })).toBe(true);

    expect(validateRendererEventPayload(IPC_CHANNELS.MCP_STATE_CHANGED, { type: 'everything' })).toBe(false);
    expect(validateRendererEventPayload(IPC_CHANNELS.VCS_STATUS_CHANGED, {
      repoPath: '/repo',
      reason: 'cosmic-rays',
      timestamp: 123,
    })).toBe(false);
  });

  it('keeps unregistered legacy events flowing during incremental migration', () => {
    expect(validateRendererEventPayload('legacy:event', { arbitrary: true })).toBe(true);
  });

  it('does not call a direct renderer sender for invalid registered payloads', () => {
    const sender = { send: vi.fn() };

    expect(sendValidatedRendererEvent(
      sender,
      IPC_CHANNELS.VOICE_LOCAL_STT_EVENT,
      { kind: 'error', error: 'missing session id' },
    )).toBe(false);
    expect(sender.send).not.toHaveBeenCalled();
  });
});
