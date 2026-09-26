import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const PREVIEW_SCENARIOS = Object.freeze([
  'default',
  'streaming',
  'gap',
  'disconnect',
  '401',
  'empty-inbox',
  'offline',
  'stale-probe',
  'transcript-1000',
  'quota-known', 'quota-unknown', 'quota-stale', 'quota-exhausted', 'quota-reset', 'quota-multi-window',
]);

const fixturePath = resolve(process.cwd(), 'scripts/preview-host/fixtures/default.json');

export async function loadPreviewFixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8'));
}

export function normalizeScenario(value) {
  return PREVIEW_SCENARIOS.includes(value) ? value : 'default';
}

export function createFixtureState(fixture, initialScenario = 'default') {
  let scenario = normalizeScenario(initialScenario);
  let snapshot = structuredClone(fixture.snapshot);
  const messages = structuredClone(fixture.messages);
  const historyMessages = structuredClone(fixture.historyMessages);
  let automations = structuredClone(fixture.automations ?? []);
  const automationOutcomes = new Map();
  const cursors = new Map();

  const projectedSnapshot = () => {
    const projected = structuredClone(snapshot);
    if (scenario === 'empty-inbox') {
      projected.prompts = [];
      projected.instances = projected.instances.map((instance) => ({
        ...instance,
        pendingApprovalCount: 0,
        hasUnreadCompletion: false,
        attentionLevel: instance.attentionLevel === 'working' ? 'working' : 'idle',
      }));
      projected.projects = projected.projects.map((project) => ({
        ...project, pendingApprovalCount: 0, needsAttentionCount: 0,
      }));
    }
    return projected;
  };

  const cursorFor = (instanceId) => {
    let cursor = cursors.get(instanceId);
    if (!cursor) {
      cursor = { bufferGeneration: 0, adapterGeneration: 1, streamSeq: -1 };
      cursors.set(instanceId, cursor);
    }
    return cursor;
  };

  return {
    get scenario() { return scenario; },
    setScenario(value) {
      scenario = normalizeScenario(value);
      return scenario;
    },
    snapshot() {
      return { ...projectedSnapshot(), serverTime: Date.now() };
    },
    instances() { return projectedSnapshot().instances; },
    projects() { return projectedSnapshot().projects; },
    prompts() { return projectedSnapshot().prompts; },
    pause() { return structuredClone(snapshot.pause); },
    quota() {
      const now = Date.now();
      const stale = scenario === 'quota-stale';
      const exhausted = scenario === 'quota-exhausted';
      const percentUsed = scenario === 'quota-unknown' ? null : scenario === 'quota-reset' ? 0 : exhausted || stale ? 100 : 40;
      const windows = [{ id: 'codex.5h', label: '5 hours', percentUsed, resetsAt: scenario === 'quota-unknown' ? null : now + 3_600_000, exhausted }];
      if (scenario === 'quota-multi-window') windows.push({ id: 'codex.weekly', label: 'Weekly', percentUsed: 72, resetsAt: now + 86_400_000, exhausted: false });
      return { serverTime: now, providers: [{ provider: 'codex', freshness: stale ? 'stale' : 'fresh', updatedAt: stale ? now - 600_000 : now, validUntil: stale ? now - 300_000 : now + 300_000, exhausted, windows }] };
    },
    automations() { return structuredClone(automations); },
    runAutomation(id, idempotencyKey) {
      const dedupeKey = `${id}:${idempotencyKey}`;
      const existing = automationOutcomes.get(dedupeKey);
      if (existing) return structuredClone(existing);
      const item = automations.find((candidate) => candidate.id === id);
      if (!item) return { status: 'skipped', reason: 'Automation no longer exists' };
      if (!item.enabled) return { status: 'skipped', reason: 'Automation is disabled' };
      const now = Date.now();
      const outcome = { status: 'started', runId: `preview-automation-run-${automationOutcomes.size + 1}` };
      automationOutcomes.set(dedupeKey, outcome);
      item.lastRun = { status: 'running', at: now };
      this.createInstance({
        workingDirectory: '/preview/automations', provider: item.provider ?? 'codex',
        model: item.model ?? undefined, initialPrompt: `${item.name} preview run`,
      });
      automations = automations.map(candidate => candidate.id === id ? item : candidate);
      return structuredClone(outcome);
    },
    setPause(paused) {
      snapshot.pause = {
        isPaused: paused,
        reasons: paused ? ['user'] : [],
        pausedAt: paused ? Date.now() : null,
        lastChange: Date.now(),
      };
      return this.pause();
    },
    clearPrompt(requestId) {
      snapshot.prompts = snapshot.prompts.filter((prompt) => prompt.requestId !== requestId);
    },
    messages(instanceId) {
      if (scenario === 'transcript-1000' && instanceId === 'preview-active') {
        return Array.from({ length: 1000 }, (_, index) => ({
          id: `preview-scale-message-${index + 1}`,
          timestamp: 1758780000000 + index * 1000,
          type: index % 2 === 0 ? 'user' : 'assistant',
          content: `Preview transcript message ${index + 1}`,
        }));
      }
      return structuredClone(messages[instanceId] ?? []);
    },
    cursor(instanceId) { return { ...cursorFor(instanceId) }; },
    recordStream(instanceId, streamSeq) { cursorFor(instanceId).streamSeq = streamSeq; },
    appendMessage(instanceId, message) {
      messages[instanceId] ??= [];
      messages[instanceId].push(structuredClone(message));
    },
    history() { return structuredClone(fixture.history); },
    historyMessages(id) { return structuredClone(historyMessages[id] ?? []); },
    models() { return structuredClone(fixture.models); },
    recentDirs() { return structuredClone(fixture.recentDirs); },
    sessionPlan(provider, model, reasoningEffort) {
      return {
        ...structuredClone(fixture.sessionPlan),
        ...(provider && provider !== 'auto' ? { provider, providerLabel: provider[0].toUpperCase() + provider.slice(1) } : {}),
        ...(model ? { model, modelLabel: model } : {}),
        ...(reasoningEffort ? { reasoningEffort, reasoningEffortLabel: reasoningEffort } : {}),
      };
    },
    cancelQueue(instanceId, queueId) {
      const instance = snapshot.instances.find((item) => item.id === instanceId);
      const queued = instance?.queuedMessages?.find((item) => item.id === queueId);
      if (!queued) return null;
      instance.queuedMessages = instance.queuedMessages.filter((item) => item.id !== queueId);
      return { message: queued.message };
    },
    rename(instanceId, displayName) {
      const instance = snapshot.instances.find((item) => item.id === instanceId);
      if (instance) instance.displayName = displayName;
      return instance ? structuredClone(instance) : null;
    },
    changeModel(instanceId, model) {
      const instance = snapshot.instances.find((item) => item.id === instanceId);
      if (instance) instance.model = model;
      return instance ? structuredClone(instance) : null;
    },
    terminate(instanceId) {
      const instance = snapshot.instances.find((item) => item.id === instanceId);
      if (instance) instance.status = 'stopped';
      return Boolean(instance);
    },
    createInstance(body) {
      const now = Date.now();
      const instance = {
        id: `preview-created-${snapshot.instances.length + 1}`,
        displayName: body.initialPrompt?.trim().slice(0, 60) || 'New preview session',
        status: 'idle',
        provider: body.provider || 'codex',
        ...(body.model ? { model: body.model } : {}),
        workingDirectory: body.workingDirectory,
        projectName: body.workingDirectory.split('/').filter(Boolean).at(-1) || 'preview',
        createdAt: now,
        lastActivity: now,
        pendingApprovalCount: 0,
        hasUnreadCompletion: false,
        attentionLevel: 'idle',
      };
      snapshot.instances.push(instance);
      messages[instance.id] = body.initialPrompt ? [{
        id: `${instance.id}-initial`, timestamp: now, type: 'user', content: body.initialPrompt,
      }] : [];
      return structuredClone(instance);
    },
  };
}
