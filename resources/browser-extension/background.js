const LEGACY_HOST_NAME = 'com.ai_orchestrator.browser_gateway';
const RELAY_HOST_NAME = 'com.ai_orchestrator.browser_gateway_relay';
const BRIDGE_DEFINITIONS = [
  { hostName: LEGACY_HOST_NAME, kind: 'local' },
  { hostName: RELAY_HOST_NAME, kind: 'relay' },
];
const INVENTORY_ALARM = 'browser-gateway-inventory';
const POLL_TIMEOUT_MS = 10000;
// The watchdog must OUTLIVE the native host's own poll-RPC budget (poll window
// + 15s), which in turn outlives the worker relay's (+10s) and the
// coordinator's hold. If this fires before the layers below give up, the port
// is torn down while a freshly dequeued command is in flight — and dropped.
const POLL_WATCHDOG_GRACE_MS = 20000;
const POLL_WATCHDOG_MS = POLL_TIMEOUT_MS + POLL_WATCHDOG_GRACE_MS;
const POLL_IDLE_DELAY_MS = 250;
const BADGE_UNHEALTHY_GRACE_MS = 60000;
const BADGE_RED = '#dc2626';
const BADGE_AMBER = '#f59e0b';
const ICON_BLUE = [37, 99, 235, 255];
const ICON_GREY = [156, 163, 175, 255];
const ICON_WHITE = [255, 255, 255, 255];
const ICON_SIZES = [16, 32];
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const MAX_OUTBOX = 50;
const MAX_INVENTORY_TABS = 40;
const MAX_SHARED_TABS = 12;
const CONTROL_GROUP_TITLE = 'Harness';
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const MAX_COMMAND_TIMEOUT_MS = 120000;
const POLL_TIMEOUT_REASON = 'browser_extension_poll_timeout';
const GATEWAY_ENABLED_STORAGE_KEY = 'browserGatewayEnabled';
const SAFE_MODE_ERROR = 'browser_safe_mode_enabled';

// Last-resort self-heal ladder. An MV3 service worker with an open native
// messaging port is kept alive by Chrome INDEFINITELY — so if its in-memory
// state ever wedges in a way the targeted watchdogs don't cover, it never
// gets the restart that would clear it: the recovery alarm just fires into
// the same wedged worker forever (observed live: a bridge that reconnected
// its port on every native-host restart but never issued another poll).
// Rung 1: no healthy poll ack for SELF_HEAL_STUCK_MS → hard-recycle every
// bridge (forced port teardown + fresh reconnect). Rung 2: still no ack
// after SELF_HEAL_RELOAD_MS → chrome.runtime.reload(), the only true reset
// for unforeseen wedge states, rate-limited via storage so a machine whose
// gateway is legitimately down cannot reload-loop.
const SELF_HEAL_STUCK_MS = 5 * 60000;
const SELF_HEAL_RECYCLE_MIN_INTERVAL_MS = 150000;
const SELF_HEAL_RELOAD_MS = 10 * 60000;
const SELF_HEAL_RELOAD_MIN_INTERVAL_MS = 30 * 60000;
const SELF_RELOAD_STORAGE_KEY = 'browserGatewayLastSelfReloadAt';
const SW_STARTED_AT = Date.now();
let lastSelfHealRecycleAt = 0;

let inventoryInFlight = false;
let gatewayEnabled = false;
let gatewayStateLoaded = false;
let gatewayStatePromise = null;
const sharedTabs = [];
const bridges = BRIDGE_DEFINITIONS.map(createBridge);

chrome.runtime.onInstalled.addListener(() => {
  // 0.5 = 30s, the MV3 minimum (Chrome ≥120). This alarm is the recovery path
  // after a service-worker suspension — halving it halves the worst-case
  // window in which queued gateway commands wait for the poll loop to restart.
  chrome.alarms.create(INVENTORY_ALARM, { periodInMinutes: 0.5 });
  void initializeGateway();
});

chrome.runtime.onStartup.addListener(() => {
  // 0.5 = 30s, the MV3 minimum (Chrome ≥120). This alarm is the recovery path
  // after a service-worker suspension — halving it halves the worst-case
  // window in which queued gateway commands wait for the poll loop to restart.
  chrome.alarms.create(INVENTORY_ALARM, { periodInMinutes: 0.5 });
  void initializeGateway();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== INVENTORY_ALARM) {
    return;
  }
  if (!gatewayEnabled) {
    persistBridgeStatus();
    return;
  }
  for (const bridge of bridges) {
    if (!recycleStalePoll(bridge)) {
      pollForCommand(bridge, { retryAbsent: true });
    }
  }
  void reportTabInventory();
  void selfHealIfWedged();
});

async function selfHealIfWedged() {
  if (!gatewayEnabled) {
    return;
  }
  const now = Date.now();
  // A young worker is still inside normal reconnect/recovery — judging it
  // would reload-loop right after every (intentional) restart.
  if (now - SW_STARTED_AT < SELF_HEAL_STUCK_MS) {
    return;
  }
  const lastAck = bridges.reduce(
    (max, bridge) => Math.max(max, bridge.lastPollAckAt ?? 0),
    0,
  );
  if (lastAck > 0 && now - lastAck < SELF_HEAL_STUCK_MS) {
    return;
  }
  // No native host installed at all — nothing to heal toward.
  if (!bridges.some((bridge) => bridge.state !== 'absent')) {
    return;
  }
  // Rung 2 (checked first so rung 1's return cannot starve it): a recycle
  // was already tried and the channel is still dead — reset the whole
  // service worker. This clears wedge states in variables no targeted
  // watchdog knows about, which is the point.
  if (
    now - SW_STARTED_AT >= SELF_HEAL_RELOAD_MS
    && lastSelfHealRecycleAt > 0
    && typeof chrome.runtime.reload === 'function'
  ) {
    const values = await chrome.storage.local.get(SELF_RELOAD_STORAGE_KEY)
      .catch(() => null);
    const lastReloadAt = typeof values?.[SELF_RELOAD_STORAGE_KEY] === 'number'
      ? values[SELF_RELOAD_STORAGE_KEY]
      : 0;
    if (lastReloadAt === 0 || now - lastReloadAt >= SELF_HEAL_RELOAD_MIN_INTERVAL_MS) {
      await chrome.storage.local.set({ [SELF_RELOAD_STORAGE_KEY]: now })
        .catch(() => undefined);
      chrome.runtime.reload();
      return;
    }
  }
  // Rung 1: forced teardown + reconnect of every bridge, same path as the
  // popup's reconnect button.
  if (now - lastSelfHealRecycleAt >= SELF_HEAL_RECYCLE_MIN_INTERVAL_MS) {
    lastSelfHealRecycleAt = now;
    await reconnectAllBridges().catch(() => undefined);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!gatewayEnabled) {
    return;
  }
  if (!isWebTab(tab) || (!changeInfo.url && !changeInfo.title && changeInfo.status !== 'complete')) {
    return;
  }
  void reportTab(tab);
});

chrome.tabs.onRemoved.addListener(() => {
  if (!gatewayEnabled) {
    return;
  }
  void reportTabInventory();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  switch (message.type) {
    case 'getStatus':
      sendResponse(getStatusPayload());
      return false;
    case 'reconnect_bridges':
      reconnectAllBridges()
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      return true;
    case 'share_active_tab':
      shareActiveTab()
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      return true;
    case 'set_gateway_enabled':
      setGatewayEnabled(message.enabled === true)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      return true;
    default:
      return false;
  }
});

void initializeGateway();

function createBridge(definition) {
  const now = Date.now();
  return {
    hostName: definition.hostName,
    kind: definition.kind,
    nativePort: null,
    pollInFlight: false,
    pollStartedAt: null,
    pollWatchdogTimer: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    forcedDisconnectPort: null,
    forcedDisconnectReason: null,
    silentPollCount: 0,
    // Buffer for non-poll messages (command results, tab attachments) so a
    // brief native-host disconnect does not silently drop them.
    outbox: [],
    state: 'disconnected',
    stateChangedAt: now,
    unhealthySince: now,
    lastPollAckAt: null,
    lastError: null,
  };
}

function setBridgeState(bridge, state) {
  if (bridge.state === state) {
    return;
  }
  bridge.state = state;
  bridge.stateChangedAt = Date.now();
  if (state === 'connected') {
    bridge.unhealthySince = null;
  } else if (bridge.unhealthySince === null) {
    bridge.unhealthySince = bridge.stateChangedAt;
  }
}

async function initializeGateway() {
  await loadGatewayEnabled();
  if (!gatewayEnabled) {
    stopAllBridges();
    persistBridgeStatus();
    return;
  }
  await startAllBridges();
}

async function loadGatewayEnabled() {
  if (gatewayStateLoaded) {
    return gatewayEnabled;
  }
  if (gatewayStatePromise) {
    return gatewayStatePromise;
  }
  gatewayStatePromise = (async () => {
    try {
      const values = await chrome.storage?.local?.get?.(GATEWAY_ENABLED_STORAGE_KEY);
      gatewayEnabled = values?.[GATEWAY_ENABLED_STORAGE_KEY] !== false;
    } catch {
      gatewayEnabled = true;
    }
    gatewayStateLoaded = true;
    gatewayStatePromise = null;
    return gatewayEnabled;
  })();
  return gatewayStatePromise;
}

async function setGatewayEnabled(enabled) {
  gatewayStateLoaded = true;
  gatewayEnabled = enabled === true;
  try {
    await chrome.storage?.local?.set?.({ [GATEWAY_ENABLED_STORAGE_KEY]: gatewayEnabled });
  } catch {
    // Storage failures should not leave the current runtime in the wrong mode.
  }
  if (gatewayEnabled) {
    await startAllBridges();
  } else {
    stopAllBridges();
  }
  persistBridgeStatus();
  return getStatusPayload();
}

function assertGatewayEnabled() {
  if (!gatewayEnabled) {
    throw new Error(SAFE_MODE_ERROR);
  }
}

function stopAllBridges() {
  for (const bridge of bridges) {
    clearReconnectTimer(bridge);
    clearPollInFlight(bridge);
    bridge.forcedDisconnectPort = null;
    bridge.forcedDisconnectReason = null;
    bridge.outbox.splice(0, bridge.outbox.length);
    const port = bridge.nativePort;
    bridge.nativePort = null;
    setBridgeState(bridge, 'disconnected');
    if (port) {
      try {
        port.disconnect?.();
      } catch {
        // The bridge is intentionally off; stale native ports can be ignored.
      }
    }
  }
}

async function startAllBridges() {
  if (!gatewayEnabled) {
    persistBridgeStatus();
    return;
  }
  for (const bridge of bridges) {
    startBridge(bridge);
  }
  await reportTabInventory().catch(() => undefined);
  for (const bridge of bridges) {
    pollForCommand(bridge);
  }
}

function startBridge(bridge) {
  if (!gatewayEnabled) {
    return;
  }
  connectNativePort(bridge, { retryAbsent: true });
  persistBridgeStatus();
}

function reconnectDelayMs(bridge) {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** bridge.reconnectAttempts);
  // ±20% jitter so many extensions/tabs don't reconnect in lockstep.
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(RECONNECT_BASE_MS, Math.round(base + jitter));
}

function scheduleReconnect(bridge) {
  if (!gatewayEnabled) {
    return;
  }
  if (bridge.reconnectTimer) {
    return;
  }
  const wait = reconnectDelayMs(bridge);
  bridge.reconnectAttempts += 1;
  setBridgeState(bridge, 'reconnecting');
  persistBridgeStatus();
  bridge.reconnectTimer = setTimeout(() => {
    bridge.reconnectTimer = null;
    startBridge(bridge);
    pollForCommand(bridge);
  }, wait);
}

function clearPollWatchdog(bridge) {
  if (bridge.pollWatchdogTimer !== null) {
    clearTimeout(bridge.pollWatchdogTimer);
    bridge.pollWatchdogTimer = null;
  }
}

function clearReconnectTimer(bridge) {
  if (bridge.reconnectTimer !== null) {
    clearTimeout(bridge.reconnectTimer);
    bridge.reconnectTimer = null;
  }
}

function clearPollInFlight(bridge) {
  bridge.pollInFlight = false;
  bridge.pollStartedAt = null;
  clearPollWatchdog(bridge);
}

function armPollWatchdog(bridge) {
  clearPollWatchdog(bridge);
  bridge.pollWatchdogTimer = setTimeout(() => {
    bridge.pollWatchdogTimer = null;
    recycleStalePoll(bridge);
  }, POLL_WATCHDOG_MS);
}

function recordPollAck(bridge) {
  bridge.lastPollAckAt = Date.now();
  bridge.pollStartedAt = null;
  clearPollWatchdog(bridge);
}

function isPollStale(bridge) {
  return bridge.pollInFlight
    && typeof bridge.pollStartedAt === 'number'
    && Date.now() - bridge.pollStartedAt >= POLL_WATCHDOG_MS;
}

function recycleStalePoll(bridge) {
  if (!isPollStale(bridge)) {
    return false;
  }
  const port = bridge.nativePort;
  clearPollInFlight(bridge);
  bridge.silentPollCount += 1;
  bridge.lastError = POLL_TIMEOUT_REASON;
  if (port) {
    bridge.forcedDisconnectPort = port;
    bridge.forcedDisconnectReason = POLL_TIMEOUT_REASON;
    try {
      port.disconnect?.();
    } catch {
      // The channel is already unusable from the extension's perspective.
    }
  }
  bridge.nativePort = null;
  scheduleReconnect(bridge);
  persistBridgeStatus();
  return true;
}

function enqueueOutbox(bridge, message) {
  bridge.outbox.push(message);
  // Drop the oldest buffered messages if the host stays down for a long time.
  while (bridge.outbox.length > MAX_OUTBOX) {
    bridge.outbox.shift();
  }
}

function flushOutbox(bridge) {
  if (!bridge.nativePort || bridge.outbox.length === 0) {
    return;
  }
  const pending = bridge.outbox.splice(0, bridge.outbox.length);
  for (let index = 0; index < pending.length; index++) {
    try {
      bridge.nativePort.postMessage(pending[index]);
    } catch {
      // Re-buffer this and the remaining messages; the disconnect handler will
      // schedule another reconnect+flush.
      for (let rest = pending.length - 1; rest >= index; rest--) {
        bridge.outbox.unshift(pending[rest]);
      }
      bridge.nativePort = null;
      clearPollInFlight(bridge);
      scheduleReconnect(bridge);
      return;
    }
  }
}

function connectNativePort(bridge, options = {}) {
  if (!gatewayEnabled) {
    return null;
  }
  if (bridge.nativePort) {
    return bridge.nativePort;
  }
  if (bridge.state === 'absent' && options.retryAbsent !== true) {
    return null;
  }
  try {
    const port = chrome.runtime.connectNative(bridge.hostName);
    bridge.nativePort = port;
    setBridgeState(bridge, 'connected');
    bridge.lastError = null;
    persistBridgeStatus();
    port.onMessage.addListener((message) => {
      // Inbound traffic means the channel is healthy again.
      bridge.reconnectAttempts = 0;
      setBridgeState(bridge, 'connected');
      bridge.lastError = null;
      void handleNativeMessage(message, bridge);
      persistBridgeStatus();
    });
    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message;
      const forcedDisconnectReason = bridge.forcedDisconnectPort === port
        ? bridge.forcedDisconnectReason
        : null;
      const isCurrentPort = bridge.nativePort === port;
      if (forcedDisconnectReason) {
        bridge.forcedDisconnectPort = null;
        bridge.forcedDisconnectReason = null;
      }
      if (!isCurrentPort) {
        return;
      }
      bridge.nativePort = null;
      clearPollInFlight(bridge);
      bridge.lastError = forcedDisconnectReason
        ?? (typeof message === 'string' && message ? message : null);
      if (forcedDisconnectReason) {
        scheduleReconnect(bridge);
        return;
      }
      if (isNativeHostAbsentError(message)) {
        setBridgeState(bridge, 'absent');
        persistBridgeStatus();
        return;
      }
      scheduleReconnect(bridge);
    });
    flushOutbox(bridge);
    return port;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNativeHostAbsentError(message)) {
      markBridgeAbsent(bridge, message);
      return null;
    }
    bridge.nativePort = null;
    clearPollInFlight(bridge);
    bridge.lastError = message;
    scheduleReconnect(bridge);
    return null;
  }
}

function markBridgeAbsent(bridge, message) {
  bridge.nativePort = null;
  clearPollInFlight(bridge);
  setBridgeState(bridge, 'absent');
  bridge.lastError = message || 'native_host_absent';
  persistBridgeStatus();
}

function isNativeHostAbsentError(message) {
  return typeof message === 'string'
    && /native messaging host.*not found|specified native messaging host not found|host not found|not installed/i.test(message);
}

function postNativeMessage(bridge, message, options = {}) {
  if (!gatewayEnabled) {
    return false;
  }
  const stampedMessage = stampNativeMessage(message);
  // Poll requests are transient — never buffer/replay them (a stale poll would
  // just confuse the host). Everything else is queued if the channel is down.
  const isPoll = stampedMessage?.type === 'poll_command';
  try {
    const port = connectNativePort(bridge, options);
    if (!port) {
      if (!isPoll && bridge.state !== 'absent') {
        enqueueOutbox(bridge, stampedMessage);
      }
      return false;
    }
    port.postMessage(stampedMessage);
    return true;
  } catch (error) {
    bridge.nativePort = null;
    clearPollInFlight(bridge);
    bridge.lastError = error instanceof Error ? error.message : String(error);
    if (isNativeHostAbsentError(bridge.lastError)) {
      setBridgeState(bridge, 'absent');
      persistBridgeStatus();
      return false;
    }
    if (!isPoll) {
      enqueueOutbox(bridge, stampedMessage);
    }
    scheduleReconnect(bridge);
    return false;
  }
}

function broadcastNativeMessage(message, options = {}) {
  if (!gatewayEnabled) {
    return [];
  }
  const recipients = [];
  for (const bridge of bridges) {
    if (postNativeMessage(bridge, message, options)) {
      recipients.push({ hostName: bridge.hostName, kind: bridge.kind });
    }
  }
  return recipients;
}

function postShareMessage(bridge, message) {
  if (!gatewayEnabled) {
    return false;
  }
  const stampedMessage = stampNativeMessage(message);
  if (!bridge.nativePort || displayStateForBridge(bridge, Date.now()) !== 'connected') {
    return false;
  }
  try {
    bridge.nativePort.postMessage(stampedMessage);
    return true;
  } catch (error) {
    bridge.nativePort = null;
    clearPollInFlight(bridge);
    bridge.lastError = error instanceof Error ? error.message : String(error);
    scheduleReconnect(bridge);
    return false;
  }
}

function broadcastShareMessage(message) {
  const recipients = [];
  for (const bridge of bridges) {
    if (postShareMessage(bridge, message)) {
      recipients.push({ hostName: bridge.hostName, kind: bridge.kind });
    }
  }
  return recipients;
}

function persistBridgeStatus() {
  const snapshots = bridges.map(statusSnapshotForBridge);
  refreshToolbarBadge(snapshots);
  refreshToolbarIcon();
  void chrome.storage?.session?.set?.({
    browserGatewayEnabled: gatewayEnabled,
    browserGatewayBridgeStatus: snapshots,
    browserGatewayBridgeStatusUpdatedAt: Date.now(),
  })?.catch(() => undefined);
}

function statusSnapshotForBridge(bridge) {
  return {
    hostName: bridge.hostName,
    kind: bridge.kind,
    state: displayStateForBridge(bridge, Date.now()),
    reconnectAttempts: bridge.reconnectAttempts,
    lastPollAckAt: bridge.lastPollAckAt,
    lastError: bridge.lastError,
    outboxLength: bridge.outbox.length,
    pollInFlight: bridge.pollInFlight,
    pollStartedAt: bridge.pollStartedAt,
    silentPollCount: bridge.silentPollCount,
    stateChangedAt: bridge.stateChangedAt,
    unhealthySince: bridge.unhealthySince,
  };
}

function displayStateForBridge(bridge, now) {
  if (!gatewayEnabled) {
    return 'disabled';
  }
  if (bridge.state === 'connected' && isConnectedBridgeStale(bridge, now)) {
    return 'dead';
  }
  if ((bridge.state === 'reconnecting' || bridge.state === 'disconnected')
    && isBridgePastUnhealthyGrace(bridge, now)) {
    return 'dead';
  }
  return bridge.state;
}

function isConnectedBridgeStale(bridge, now) {
  const contactAt = bridge.lastPollAckAt ?? bridge.stateChangedAt;
  return typeof contactAt === 'number' && now - contactAt > BADGE_UNHEALTHY_GRACE_MS;
}

function isBridgePastUnhealthyGrace(bridge, now) {
  return typeof bridge.unhealthySince === 'number'
    && now - bridge.unhealthySince > BADGE_UNHEALTHY_GRACE_MS;
}

function deriveToolbarBadgeState(snapshots, now = Date.now()) {
  const unhealthyCount = snapshots.filter((snapshot) => isSnapshotBadForBadge(snapshot, now)).length;
  if (unhealthyCount === snapshots.length && unhealthyCount > 0) {
    return { text: '!', color: BADGE_RED };
  }
  if (snapshots.length === 2 && unhealthyCount === 1) {
    return { text: '!', color: BADGE_AMBER };
  }
  return { text: '', color: null };
}

function isSnapshotBadForBadge(snapshot, now) {
  if (snapshot.state === 'dead') {
    return true;
  }
  if (snapshot.state === 'absent' || snapshot.state === 'reconnecting' || snapshot.state === 'disconnected') {
    return typeof snapshot.unhealthySince === 'number'
      && now - snapshot.unhealthySince > BADGE_UNHEALTHY_GRACE_MS;
  }
  if (snapshot.state === 'connected') {
    const contactAt = snapshot.lastPollAckAt ?? snapshot.stateChangedAt;
    return typeof contactAt === 'number' && now - contactAt > BADGE_UNHEALTHY_GRACE_MS;
  }
  return false;
}

function refreshToolbarBadge(snapshots) {
  const badge = deriveToolbarBadgeState(snapshots);
  void chrome.action?.setBadgeText?.({ text: badge.text })?.catch(() => undefined);
  if (badge.color) {
    void chrome.action?.setBadgeBackgroundColor?.({ color: badge.color })?.catch(() => undefined);
  }
}

function refreshToolbarIcon() {
  if (!chrome.action?.setIcon) {
    return;
  }
  const color = gatewayEnabled ? ICON_BLUE : ICON_GREY;
  const imageData = {};
  for (const size of ICON_SIZES) {
    imageData[size] = createToolbarIconImageData(size, color);
  }
  void chrome.action.setIcon({ imageData }).catch(() => undefined);
}

function createToolbarIconImageData(size, color) {
  const data = new Uint8ClampedArray(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size * 0.43;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - center, y - center);
      if (distance > radius) {
        continue;
      }
      const offset = (y * size + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = color[3];
    }
  }
  drawToolbarIconH(data, size);
  return new ImageData(data, size, size);
}

function drawToolbarIconH(data, size) {
  const barWidth = Math.max(2, Math.round(size * 0.13));
  const top = Math.round(size * 0.25);
  const bottom = Math.round(size * 0.75);
  const leftX = Math.round(size * 0.31);
  const rightX = Math.round(size * 0.62);
  const crossTop = Math.round(size * 0.44);
  fillIconRect(data, size, leftX, top, leftX + barWidth, bottom, ICON_WHITE);
  fillIconRect(data, size, rightX, top, rightX + barWidth, bottom, ICON_WHITE);
  fillIconRect(data, size, leftX, crossTop, rightX + barWidth, crossTop + barWidth, ICON_WHITE);
}

function fillIconRect(data, size, left, top, right, bottom, color) {
  for (let y = Math.max(0, top); y < Math.min(size, bottom); y++) {
    for (let x = Math.max(0, left); x < Math.min(size, right); x++) {
      const offset = (y * size + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = color[3];
    }
  }
}

function getStatusPayload() {
  const snapshots = bridges.map(statusSnapshotForBridge);
  return {
    ok: true,
    gatewayEnabled,
    extensionVersion: chrome.runtime.getManifest?.().version ?? 'unknown',
    bridges: snapshots,
    sharedTabs: sharedTabs.slice(),
    badge: deriveToolbarBadgeState(snapshots),
  };
}

function extensionRuntimeEvidence() {
  return {
    extensionVersion: chrome.runtime.getManifest?.().version ?? 'unknown',
    extensionStartedAt: SW_STARTED_AT,
  };
}

function stampNativeMessage(message) {
  if (!message || typeof message !== 'object') {
    return message;
  }
  return {
    ...message,
    ...extensionRuntimeEvidence(),
  };
}

async function reconnectAllBridges() {
  if (!gatewayEnabled) {
    persistBridgeStatus();
    return getStatusPayload();
  }
  for (const bridge of bridges) {
    clearReconnectTimer(bridge);
    clearPollInFlight(bridge);
    const port = bridge.nativePort;
    bridge.nativePort = null;
    bridge.forcedDisconnectPort = null;
    bridge.forcedDisconnectReason = null;
    bridge.lastError = null;
    bridge.reconnectAttempts = 0;
    setBridgeState(bridge, 'disconnected');
    if (port) {
      try {
        port.disconnect?.();
      } catch {
        // Reconnect is best-effort; stale channels are replaced below.
      }
    }
    startBridge(bridge);
    pollForCommand(bridge, { retryAbsent: true });
  }
  await reportTabInventory().catch(() => undefined);
  persistBridgeStatus();
  return getStatusPayload();
}

// Commands must execute strictly one-at-a-time. The inventory alarm and the
// reconnect path both call pollForCommand() unconditionally, and the gateway
// hands the next queued command to any open poll — so a poll opened while a
// command is still executing delivers a second command concurrently. Two
// overlapping CDP commands double-attach chrome.debugger on the same tab,
// which Chrome rejects ("Another debugger is already attached to the tab")
// and which has crashed the tab's renderer (RESULT_CODE_KILLED_BAD_MESSAGE).
let commandChain = Promise.resolve();

async function handleNativeMessage(message, bridge) {
  if (!gatewayEnabled) {
    clearPollInFlight(bridge);
    persistBridgeStatus();
    return;
  }
  if (!message || message.type !== 'browser_command') {
    if (isForwardAckReply(message)) {
      // Ack (or failure) for a receipt/result/inventory forward we posted.
      // A FAILED forward must never be treated as a poll error: clearing
      // pollInFlight mid-command lets the alarm open a second poll and pull
      // a second command while this one is still executing.
      if (isNativeHostErrorReply(message)) {
        bridge.lastError = message.error;
      }
      persistBridgeStatus();
      return;
    }
    if (handleNativePollError(message, bridge)) {
      return;
    }
    persistBridgeStatus();
    return;
  }
  recordPollAck(bridge);
  if (!message.command) {
    clearPollInFlight(bridge);
    persistBridgeStatus();
    scheduleNextPoll(bridge, POLL_IDLE_DELAY_MS);
    return;
  }
  const command = message.command;
  // Ack receipt BEFORE executing: the gateway uses this to distinguish "the
  // handoff died and the command never ran" (safe to retry) from "the command
  // ran but its result never came back" (verify before retrying a mutation).
  postNativeMessage(bridge, {
    type: 'command_received',
    commandId: command.id,
  });
  commandChain = commandChain.then(() => runBrowserCommand(command, bridge));
  await commandChain;
}

function handleNativePollError(message, bridge) {
  if (!bridge.pollInFlight || !isNativeHostErrorReply(message)) {
    return false;
  }
  bridge.lastError = message.error;
  clearPollInFlight(bridge);
  persistBridgeStatus();
  scheduleNextPoll(bridge, POLL_TIMEOUT_MS);
  return true;
}

// Replies from a new-build native host carry the originating frame type as
// ackType. Anything tagged with a non-poll ackType is a forward ack, not a
// poll reply. An old-build native host sends untagged replies — those keep
// the legacy (poll-error) routing, degrading to today's behavior.
function isForwardAckReply(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && typeof message.ackType === 'string'
    && message.ackType !== 'poll_command',
  );
}

function isNativeHostErrorReply(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.ok === false
    && typeof message.error === 'string'
    && message.error,
  );
}

async function runBrowserCommand(command, bridge) {
  try {
    assertGatewayEnabled();
    const result = await runCommandWithWatchdog(command);
    if (isTabPayload(result)) {
      broadcastNativeMessage({ type: 'attach_tab', tab: result });
    }
    postNativeMessage(bridge, {
      type: 'command_result',
      commandId: command.id,
      ok: true,
      result,
    });
  } catch (error) {
    postNativeMessage(bridge, {
      type: 'command_result',
      commandId: command.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // Only now is the extension ready for the next command. Clearing the poll
    // flag any earlier lets the alarm-driven poll pull a second command while
    // this one is still running (the disconnect handler still resets the flag
    // if the channel drops mid-command; the commandChain stays the correctness
    // backstop for any command that arrives through that path).
    clearPollInFlight(bridge);
    persistBridgeStatus();
    scheduleNextPoll(bridge, 0);
  }
}

function runCommandWithWatchdog(command) {
  const timeoutMs = commandExecutionTimeoutMs(command);
  let settled = false;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      void forceReleaseCommandResources(command);
      reject(new Error('browser_extension_command_timeout'));
    }, timeoutMs);

    Promise.resolve()
      .then(() => executeBrowserCommand(command))
      .then((result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      }, (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function commandExecutionTimeoutMs(command) {
  const value = command?.timeoutMs;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  return Math.max(1000, Math.min(MAX_COMMAND_TIMEOUT_MS, Math.floor(value)));
}

async function forceReleaseCommandResources(command) {
  const tabId = command?.target?.tabId;
  if (typeof tabId !== 'number') {
    return;
  }
  tabDebuggerChains.delete(tabId);
  if (chrome.debugger?.detach) {
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
  }
  await stopControlledTab(tabId).catch(() => undefined);
}

function pollForCommand(bridge, options = {}) {
  if (!gatewayEnabled) {
    return;
  }
  if (bridge.pollInFlight) {
    return;
  }
  bridge.pollInFlight = true;
  bridge.pollStartedAt = Date.now();
  armPollWatchdog(bridge);
  const posted = postNativeMessage(bridge, {
    type: 'poll_command',
    timeoutMs: POLL_TIMEOUT_MS,
  }, options);
  if (!posted) {
    clearPollInFlight(bridge);
  }
  persistBridgeStatus();
}

function scheduleNextPoll(bridge, delayMs) {
  if (!gatewayEnabled) {
    return;
  }
  setTimeout(() => pollForCommand(bridge), delayMs);
}

async function reportTabInventory() {
  if (!gatewayEnabled) {
    return;
  }
  if (inventoryInFlight) {
    return;
  }
  inventoryInFlight = true;
  try {
    const tabs = (await chrome.tabs.query({}))
      .filter(isWebTab)
      .slice(0, MAX_INVENTORY_TABS);
    const tabPayloads = [];
    for (const tab of tabs) {
      tabPayloads.push(await buildTabPayload(tab, { includeText: true }));
    }
    if (tabPayloads.length > 0) {
      broadcastNativeMessage({
        type: 'tab_inventory',
        tabs: tabPayloads,
      });
    }
  } finally {
    inventoryInFlight = false;
  }
}

async function reportTab(tab) {
  if (!gatewayEnabled) {
    return;
  }
  if (!isWebTab(tab)) {
    return;
  }
  const payload = await buildTabPayload(tab, { includeText: true }).catch(() => null);
  if (!payload) {
    return;
  }
  broadcastNativeMessage({
    type: 'attach_tab',
    tab: payload,
  });
}

async function shareActiveTab() {
  assertGatewayEnabled();
  const tab = await findActiveWebTabForSharing();
  if (!isWebTab(tab)) {
    throw new Error('No active Chrome tab is available to share.');
  }

  const tabPayload = await buildTabPayload(tab, {
    includeText: true,
    includeScreenshot: true,
  });
  const recipients = broadcastShareMessage({
    type: 'attach_tab',
    tab: tabPayload,
  });
  if (recipients.length > 0) {
    rememberSharedTab(tabPayload, recipients);
    persistBridgeStatus();
  }

  return {
    ok: recipients.length > 0,
    recipients,
  };
}

function rememberSharedTab(tab, recipients) {
  const entry = {
    tabId: tab.tabId,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
    sharedAt: Date.now(),
    recipients,
  };
  const existingIndex = sharedTabs.findIndex((candidate) => candidate.tabId === tab.tabId);
  if (existingIndex >= 0) {
    sharedTabs.splice(existingIndex, 1);
  }
  sharedTabs.unshift(entry);
  while (sharedTabs.length > MAX_SHARED_TABS) {
    sharedTabs.pop();
  }
}

async function findActiveWebTabForSharing() {
  const focusedTabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  }).catch(() => []);
  const focusedTab = focusedTabs.find(isWebTab);
  if (focusedTab) {
    return focusedTab;
  }

  const currentWindowTabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  }).catch(() => []);
  const currentWindowTab = currentWindowTabs.find(isWebTab);
  if (currentWindowTab) {
    return currentWindowTab;
  }

  const tabs = await chrome.tabs.query({}).catch(() => []);
  return tabs.find((tab) => tab.active && isWebTab(tab))
    ?? tabs.find(isWebTab)
    ?? null;
}

async function executeBrowserCommand(command) {
  assertGatewayEnabled();
  switch (command.command) {
    case 'report_inventory':
      await reportTabInventory();
      return { reported: true };
    case 'open_tab': {
      const url = requirePayloadString(command, 'url');
      const tab = await chrome.tabs.create({ url, active: true });
      await startControlledTab(tab.id);
      try {
        await waitForTabComplete(tab.id);
        // Re-instrument the freshly-loaded document: the full load replaced the
        // MAIN world, wiping the capture buffer installed by startControlledTab
        // above. Without this, a console_messages/network_requests read right
        // after open_tab would find no buffer at all.
        await installControlGlow(tab.id);
        await installConsoleNetworkCapture(tab.id);
        return buildTabPayload(await chrome.tabs.get(tab.id), {
          includeText: true,
          includeScreenshot: true,
        });
      } finally {
        await stopControlledTab(tab.id);
      }
    }
    case 'navigate': {
      const tabId = requireTargetTabId(command);
      const url = requirePayloadString(command, 'url');
      await startControlledTab(tabId);
      try {
        const tab = await chrome.tabs.update(tabId, { url, active: true });
        await waitForTabComplete(tabId);
        // Re-instrument after the full document load (see open_tab note): the
        // new document has a fresh MAIN world, so the capture buffer must be
        // reinstalled here or a post-navigate read comes back empty.
        await installControlGlow(tabId);
        await installConsoleNetworkCapture(tabId);
        return buildTabPayload(tab || await chrome.tabs.get(tabId), {
          includeText: true,
          includeScreenshot: true,
        });
      } finally {
        await stopControlledTab(tabId);
      }
    }
    case 'click': {
      const uid = optionalUidValue(command.payload?.uid);
      if (uid !== null) {
        return clickByUid(requireTargetTabId(command), uid);
      }
      return runInTargetTab(command, 'click', [
        requirePayloadString(command, 'selector'),
      ]);
    }
    case 'type': {
      const uid = optionalUidValue(command.payload?.uid);
      const value = requirePayloadString(command, 'value');
      if (uid !== null) {
        return typeByUid(requireTargetTabId(command), uid, value);
      }
      return runInTargetTab(command, 'type', [
        requirePayloadString(command, 'selector'),
        value,
      ]);
    }
    case 'fill_form':
      return fillFormCommand(command);
    case 'select': {
      const uid = optionalUidValue(command.payload?.uid);
      const value = requirePayloadString(command, 'value');
      if (uid !== null) {
        return selectByUid(requireTargetTabId(command), uid, value);
      }
      return runInTargetTab(command, 'select', [
        requirePayloadString(command, 'selector'),
        value,
      ]);
    }
    case 'upload_file':
      return uploadFileInTargetTab(command);
    case 'accessibility_snapshot': {
      const tabId = requireTargetTabId(command);
      await startControlledTab(tabId);
      try {
        return await captureAccessibilitySnapshot(tabId, {
          interestingOnly: command.payload?.interestingOnly !== false,
          limit: typeof command.payload?.limit === 'number' ? command.payload.limit : 2000,
        });
      } finally {
        await stopControlledTab(tabId);
      }
    }
    case 'evaluate': {
      const tabId = requireTargetTabId(command);
      const expression = requirePayloadString(command, 'expression');
      await startControlledTab(tabId);
      try {
        return await evaluateInTab(tabId, expression, command.payload?.awaitPromise !== false);
      } finally {
        await stopControlledTab(tabId);
      }
    }
    case 'download_file':
      return downloadFileFromTargetTab(command);
    case 'snapshot': {
      const tabId = requireTargetTabId(command);
      await startControlledTab(tabId);
      try {
        const tab = await chrome.tabs.get(tabId);
        return buildTabPayload(tab, { includeText: true });
      } finally {
        await stopControlledTab(tabId);
      }
    }
    case 'screenshot': {
      const tabId = requireTargetTabId(command);
      await startControlledTab(tabId);
      try {
        return {
          screenshotBase64: await captureTabScreenshot(tabId, {
            fullPage: command.payload?.fullPage === true,
            maxWidth: command.payload?.maxWidth,
            maxHeight: command.payload?.maxHeight,
          }),
          capturedAt: Date.now(),
        };
      } finally {
        await stopControlledTab(tabId);
      }
    }
    case 'wait_for': {
      const tabId = requireTargetTabId(command);
      const selector = typeof command.payload?.selector === 'string' ? command.payload.selector : 'body';
      const timeoutMs = typeof command.payload?.timeoutMs === 'number' ? command.payload.timeoutMs : 30000;
      await startControlledTab(tabId);
      try {
        return await waitForSelectorAcrossFrames(tabId, selector, timeoutMs);
      } finally {
        await stopControlledTab(tabId);
      }
    }
    case 'query_elements':
      return runInTargetTab(command, 'query_elements', [
        typeof command.payload?.query === 'string' ? command.payload.query : undefined,
        typeof command.payload?.limit === 'number' ? command.payload.limit : undefined,
      ]);
    case 'console_messages':
      return readCapturedEntries(command, 'console');
    case 'network_requests':
      return readCapturedEntries(command, 'network');
    case 'read_control':
      return runInTargetTab(command, 'read_control', [
        requirePayloadString(command, 'selector'),
      ]);
    default:
      throw new Error(`Unsupported browser command: ${command.command}`);
  }
}

async function uploadFileInTargetTab(command) {
  const tabId = requireTargetTabId(command);
  const selector = requirePayloadString(command, 'selector');
  const filePath = requirePayloadString(command, 'filePath');
  let uploadState = { uploaded: false, fileCount: 0, files: [] };
  await startControlledTab(tabId);
  try {
    await withDebugger(tabId, async (debuggee) => {
      const evaluation = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: `(${resolveFileInputScript.toString()})(${JSON.stringify(selector)})`,
        objectGroup: 'aio-upload',
        includeCommandLineAPI: false,
        silent: true,
        returnByValue: false,
        awaitPromise: false,
      });
      const remoteObject = evaluation?.result;
      const objectId = remoteObject?.objectId;
      if (!objectId) {
        throw new Error('Browser upload file input was not found.');
      }
      try {
        await chrome.debugger.sendCommand(debuggee, 'DOM.setFileInputFiles', {
          objectId,
          files: [filePath],
        });
        const stateEvaluation = await chrome.debugger.sendCommand(debuggee, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function() {
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            const files = Array.from(this.files || []).map((file) => ({
              name: String(file.name || '').slice(0, 255),
              size: typeof file.size === 'number' ? file.size : undefined,
              type: String(file.type || '').slice(0, 200),
            }));
            return {
              uploaded: files.length > 0,
              fileCount: files.length,
              files,
            };
          }`,
          awaitPromise: false,
          returnByValue: true,
        });
        uploadState = stateEvaluation?.result?.value ?? uploadState;
      } finally {
        await chrome.debugger.sendCommand(debuggee, 'Runtime.releaseObjectGroup', {
          objectGroup: 'aio-upload',
        }).catch(() => undefined);
      }
    });
    await reportTab(await chrome.tabs.get(tabId));
    return { selector, ...uploadState };
  } finally {
    await stopControlledTab(tabId);
  }
}

async function downloadFileFromTargetTab(command) {
  const tabId = requireTargetTabId(command);
  const timeoutMs = typeof command.payload?.timeoutMs === 'number'
    ? command.payload.timeoutMs
    : 60000;
  await startControlledTab(tabId);
  try {
    const url = typeof command.payload?.url === 'string' ? command.payload.url : undefined;
    const selector = typeof command.payload?.selector === 'string' ? command.payload.selector : undefined;
    const suggestedFilename = typeof command.payload?.suggestedFilename === 'string'
      ? command.payload.suggestedFilename
      : undefined;
    if (url) {
      const downloadId = await chrome.downloads.download({
        url,
        ...(suggestedFilename ? { filename: sanitizeDownloadFilename(suggestedFilename) } : {}),
        conflictAction: 'uniquify',
        saveAs: false,
      });
      return waitForDownloadComplete(downloadId, timeoutMs);
    }
    if (!selector) {
      throw new Error('Browser download requires selector or url.');
    }
    const download = waitForNextDownloadComplete(timeoutMs);
    await runInTargetTab(command, 'click', [selector]);
    return download;
  } finally {
    await stopControlledTab(tabId);
  }
}

// chrome.debugger allows a single attached client per tab. Sessions on the
// same tab are serialized through a per-tab promise chain so an overlapping
// capture (e.g. the popup's share-tab screenshot racing a command, which does
// NOT go through the command queue) waits its turn instead of double-attaching.
const tabDebuggerChains = new Map();

function withDebugger(tabId, callback) {
  assertGatewayEnabled();
  const previous = tabDebuggerChains.get(tabId) ?? Promise.resolve();
  const run = previous.then(() => attachAndRunDebugger(tabId, callback));
  // Chain on settlement (not success) so one failed session does not poison
  // the queue; drop the map entry once the tab goes idle.
  const settled = run.then(() => undefined, () => undefined);
  tabDebuggerChains.set(tabId, settled);
  void settled.then(() => {
    if (tabDebuggerChains.get(tabId) === settled) {
      tabDebuggerChains.delete(tabId);
    }
  });
  return run;
}

const DEBUGGER_BUSY_PATTERN = /already attached/i;
const DEBUGGER_ATTACH_RETRIES = 2;
const DEBUGGER_ATTACH_RETRY_DELAY_MS = 300;

async function attachAndRunDebugger(tabId, callback) {
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand) {
    throw new Error('Chrome debugger API is unavailable.');
  }
  const debuggee = { tabId };
  await attachDebugger(debuggee);
  try {
    await applyDebuggerKeepAlive(debuggee);
    return await callback(debuggee);
  } finally {
    await chrome.debugger.detach(debuggee).catch(() => undefined);
  }
}

// For the duration of this CDP session, make the tab report as focused/visible
// and force it out of the frozen/discarded lifecycle states. When a tab is not
// the foreground tab Chrome throttles its timers/rAF and can freeze the
// renderer, which silently stalls a command mid-flight (the gateway then sees a
// timeout, and a blind retry of a non-idempotent action duplicates work). These
// overrides are tied to the debugger session and reset on detach, so they are
// re-applied on every session; preventTabDiscard() covers the idle gaps between
// commands when no debugger is attached.
async function applyDebuggerKeepAlive(debuggee) {
  await chrome.debugger
    .sendCommand(debuggee, 'Emulation.setFocusEmulationEnabled', { enabled: true })
    .catch(() => undefined);
  await chrome.debugger
    .sendCommand(debuggee, 'Page.setWebLifecycleState', { state: 'active' })
    .catch(() => undefined);
}

// Attach with a short retry: the detach of a just-finished session can still
// be settling in the browser process. If the tab stays held by an external
// client (a DevTools window open on the tab, or another CDP-based tool), fail
// with a clear, actionable error instead of the raw Chrome message.
async function attachDebugger(debuggee) {
  for (let attempt = 0; ; attempt++) {
    try {
      await chrome.debugger.attach(debuggee, '1.3');
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!DEBUGGER_BUSY_PATTERN.test(message)) {
        throw error;
      }
      if (attempt >= DEBUGGER_ATTACH_RETRIES) {
        throw new Error(
          'browser_tab_debugger_busy: another debugger is attached to this tab '
          + '(a DevTools window or another automation client). Close it and retry.',
        );
      }
      await delay(DEBUGGER_ATTACH_RETRY_DELAY_MS);
    }
  }
}

const CDP_UID_OBJECT_GROUP = 'aio-uid';

function optionalUidValue(uid) {
  return typeof uid === 'string' && uid ? uid : null;
}

// uid is the stringified CDP backendDOMNodeId returned by accessibility_snapshot.
function parseBackendNodeId(uid) {
  const backendNodeId = Number.parseInt(uid, 10);
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0 || String(backendNodeId) !== String(uid)) {
    throw new Error(`Invalid browser element uid: ${uid}`);
  }
  return backendNodeId;
}

// Resolve a backendDOMNodeId to a live RemoteObject and run `functionDeclaration`
// with `this` bound to that element, reusing an already-attached debugger
// session. Unlike document.querySelector this reaches elements inside CLOSED
// shadow roots, because the node is resolved through the DevTools protocol
// rather than the page's DOM-visibility rules. The backendNodeId comes from
// accessibility_snapshot and stays valid until the node is removed or the page
// navigates (a stale uid surfaces as a clear "could not be resolved" error).
async function resolveAndCallOnDebuggee(debuggee, uid, functionDeclaration, args = []) {
  const backendNodeId = parseBackendNodeId(uid);
  const resolved = await chrome.debugger.sendCommand(debuggee, 'DOM.resolveNode', {
    backendNodeId,
    objectGroup: CDP_UID_OBJECT_GROUP,
  });
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw new Error(`Browser element uid could not be resolved: ${uid}`);
  }
  const evaluation = await chrome.debugger.sendCommand(debuggee, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
    silent: false,
  });
  if (evaluation?.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description
      || evaluation.exceptionDetails.text
      || 'browser_uid_action_failed',
    );
  }
  return evaluation?.result?.value;
}

// Single-action convenience: attach the debugger, resolve+act, release, detach.
async function callOnBackendNode(tabId, uid, functionDeclaration, args = []) {
  return withDebugger(tabId, async (debuggee) => {
    await chrome.debugger.sendCommand(debuggee, 'DOM.enable').catch(() => undefined);
    try {
      return await resolveAndCallOnDebuggee(debuggee, uid, functionDeclaration, args);
    } finally {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.releaseObjectGroup', {
        objectGroup: CDP_UID_OBJECT_GROUP,
      }).catch(() => undefined);
    }
  });
}

async function clickByUid(tabId, uid) {
  await startControlledTab(tabId);
  try {
    const result = await callOnBackendNode(tabId, uid, `(${uidClickFn.toString()})`);
    await reportTab(await chrome.tabs.get(tabId));
    return result;
  } finally {
    await stopControlledTab(tabId);
  }
}

async function typeByUid(tabId, uid, value) {
  await startControlledTab(tabId);
  try {
    const result = await callOnBackendNode(tabId, uid, `(${uidTypeFn.toString()})`, [value]);
    await reportTab(await chrome.tabs.get(tabId));
    return result;
  } finally {
    await stopControlledTab(tabId);
  }
}

async function selectByUid(tabId, uid, value) {
  await startControlledTab(tabId);
  try {
    const result = await callOnBackendNode(tabId, uid, `(${uidSelectFn.toString()})`, [value]);
    await reportTab(await chrome.tabs.get(tabId));
    return result;
  } finally {
    await stopControlledTab(tabId);
  }
}

async function typeBySelectorInTab(tabId, selector, value) {
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: pageBridgeScript,
    args: ['type', [selector, value]],
  });
  const frameResults = (injectionResults ?? [])
    .map((entry) => entry?.result)
    .filter((entry) => entry != null);
  return mergeFrameResults('type', frameResults, [selector, value]);
}

// fill_form supports per-field uid (robust, closed-shadow-safe) and per-field
// selector. When no field uses a uid this is the original all-frames page-bridge
// path; otherwise the debugger is attached ONCE for the whole form and each uid
// field is resolved within that single session (avoids per-field attach/detach
// banner flicker and latency).
async function fillFormCommand(command) {
  const fields = Array.isArray(command.payload?.fields) ? command.payload.fields : [];
  const usesUid = fields.some((field) => field && optionalUidValue(field.uid) !== null);
  if (!usesUid) {
    return runInTargetTab(command, 'fill_form', [fields]);
  }

  const tabId = requireTargetTabId(command);
  const typeFn = `(${uidTypeFn.toString()})`;
  await startControlledTab(tabId);
  try {
    const results = await withDebugger(tabId, async (debuggee) => {
      await chrome.debugger.sendCommand(debuggee, 'DOM.enable').catch(() => undefined);
      const out = [];
      try {
        for (const field of fields) {
          const value = String(field?.value ?? '');
          const uid = optionalUidValue(field?.uid);
          if (uid !== null) {
            const applied = await resolveAndCallOnDebuggee(debuggee, uid, typeFn, [value]);
            out.push({ ...(field?.selector ? { selector: field.selector } : {}), uid, ...applied });
          } else if (typeof field?.selector === 'string' && field.selector) {
            const applied = await typeBySelectorInTab(tabId, field.selector, value);
            out.push({ selector: field.selector, ...applied });
          } else {
            throw new Error('Browser fill_form field requires a selector or uid.');
          }
        }
      } finally {
        await chrome.debugger.sendCommand(debuggee, 'Runtime.releaseObjectGroup', {
          objectGroup: CDP_UID_OBJECT_GROUP,
        }).catch(() => undefined);
      }
      return out;
    });
    await reportTab(await chrome.tabs.get(tabId));
    return results;
  } finally {
    await stopControlledTab(tabId);
  }
}

// --- Self-contained element operations run via Runtime.callFunctionOn -------
// These run in the page's MAIN world with `this` bound to the resolved element.
// They intentionally duplicate the pageBridgeScript event logic because
// callFunctionOn requires a standalone, self-contained function body.

function uidClickFn() {
  const element = this;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = element.getBoundingClientRect
    ? element.getBoundingClientRect()
    : { left: 0, top: 0, width: 0, height: 0 };
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const mouseInit = {
    bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY, button: 0,
  };
  const pointerInit = {
    ...mouseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1,
  };
  try { if (element.focus) element.focus(); } catch (error) { void error; }
  const PointerEventCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  element.dispatchEvent(new PointerEventCtor('pointerover', { ...pointerInit, buttons: 0 }));
  element.dispatchEvent(new MouseEvent('mouseover', { ...mouseInit, buttons: 0 }));
  element.dispatchEvent(new PointerEventCtor('pointerdown', { ...pointerInit, buttons: 1 }));
  element.dispatchEvent(new MouseEvent('mousedown', { ...mouseInit, buttons: 1 }));
  element.dispatchEvent(new PointerEventCtor('pointerup', { ...pointerInit, buttons: 0 }));
  element.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
  element.dispatchEvent(new MouseEvent('click', { ...mouseInit, buttons: 0 }));
  return {
    tagName: element.tagName,
    text: (element.innerText || element.textContent || '').slice(0, 1000),
    disabled: Boolean(element.disabled),
    connected: element.isConnected !== false,
  };
}

function uidTypeFn(value) {
  const element = this;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  try { if (element.focus) element.focus(); } catch (error) { void error; }
  const prototype = typeof HTMLTextAreaElement !== 'undefined' && element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : typeof HTMLInputElement !== 'undefined' && element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : typeof HTMLSelectElement !== 'undefined' && element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : null;
  const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'value');
  if (element.isContentEditable) {
    // Rich-text editors (Slate/Lexical/ProseMirror-style) keep their own model
    // in sync via native 'beforeinput'/'input' events; a bulk textContent
    // overwrite bypasses that and desyncs on the editor's next render. Select
    // the existing content and use execCommand('insertText', ...) so the
    // replacement travels through the same native editing pipeline a real
    // keystroke would, falling back to textContent only if that's unavailable.
    try {
      const selection = typeof window !== 'undefined' ? window.getSelection() : null;
      if (selection && typeof document !== 'undefined' && document.createRange) {
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const inserted = typeof document !== 'undefined'
        && typeof document.execCommand === 'function'
        && document.execCommand('insertText', false, value);
      if (!inserted) {
        element.textContent = value;
      }
    } catch (error) {
      void error;
      element.textContent = value;
    }
  } else if (descriptor && typeof descriptor.set === 'function') {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  const valueAfter = element.isContentEditable
    ? (element.textContent || '')
    : (typeof element.value === 'string' ? element.value : '');
  return {
    tagName: element.tagName,
    valueAfter: String(valueAfter).slice(0, 1000),
    valueApplied: valueAfter === value,
    disabled: Boolean(element.disabled),
    readOnly: Boolean(element.readOnly),
  };
}

function uidSelectFn(value) {
  const element = this;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (element.tagName === 'SELECT') {
    try { if (element.focus) element.focus(); } catch (error) { void error; }
    const options = Array.from(element.options || []);
    const match = options.find((option) => option.value === value)
      || options.find((option) => (option.label || '').trim() === String(value).trim())
      || options.find((option) => (option.textContent || '').trim().toLowerCase() === String(value).trim().toLowerCase());
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(element, match ? match.value : value);
    } else {
      element.value = match ? match.value : value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      tagName: element.tagName,
      selectedValue: typeof element.value === 'string' ? element.value : undefined,
      matchedOption: match ? (match.label || match.textContent || match.value || '').trim().slice(0, 200) : null,
    };
  }
  // A uid points at a single node, but a custom dropdown's option is a SEPARATE
  // node, so uid select cannot reach it. Fail honestly (rather than report a
  // misleading success) and tell the caller how to proceed.
  throw new Error(
    'uid select requires a native <select>; for a custom dropdown, click the control by uid, '
    + 're-run accessibility_snapshot, then click the option by its uid.',
  );
}

// Capture a flattened accessibility tree via CDP. The AX tree pierces open AND
// closed shadow roots (and same-origin iframes; cross-origin OOPIFs are not
// traversed), so it surfaces inputs that deepQuerySelector (which can only walk
// node.shadowRoot) cannot see when the page attached a closed shadow root before
// our content-script patch ran. Each node carries a `uid` (the backendDOMNodeId)
// usable as the robust target for click/type/etc.
async function captureAccessibilitySnapshot(tabId, options) {
  const interestingOnly = options.interestingOnly !== false;
  const limit = Math.max(1, Math.min(typeof options.limit === 'number' ? options.limit : 2000, 2000));
  return withDebugger(tabId, async (debuggee) => {
    await chrome.debugger.sendCommand(debuggee, 'DOM.enable').catch(() => undefined);
    await chrome.debugger.sendCommand(debuggee, 'Accessibility.enable').catch(() => undefined);
    const tree = await chrome.debugger.sendCommand(debuggee, 'Accessibility.getFullAXTree', {});
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const out = [];
    for (const node of nodes) {
      if (out.length >= limit) {
        break;
      }
      if (interestingOnly && node.ignored) {
        continue;
      }
      if (typeof node.backendDOMNodeId !== 'number') {
        continue;
      }
      const role = node.role?.value;
      if (typeof role !== 'string' || !role) {
        continue;
      }
      if (interestingOnly && (role === 'none' || role === 'generic' || role === 'InlineTextBox')) {
        continue;
      }
      const entry = { uid: String(node.backendDOMNodeId), role };
      const name = node.name?.value;
      if (typeof name === 'string' && name.trim()) {
        entry.name = name.slice(0, 2000);
      }
      const value = node.value?.value;
      if (typeof value === 'string' && value) {
        entry.value = value.slice(0, 2000);
      }
      const description = node.description?.value;
      if (typeof description === 'string' && description) {
        entry.description = description.slice(0, 2000);
      }
      for (const property of node.properties ?? []) {
        const raw = property?.value?.value;
        switch (property?.name) {
          case 'checked':
            entry.checked = raw === 'mixed' ? 'mixed' : raw === true || raw === 'true';
            break;
          case 'selected':
            entry.selected = raw === true || raw === 'true';
            break;
          case 'expanded':
            entry.expanded = raw === true || raw === 'true';
            break;
          case 'disabled':
            entry.disabled = raw === true || raw === 'true';
            break;
          case 'focused':
            entry.focused = raw === true || raw === 'true';
            break;
          case 'level':
            if (typeof raw === 'number') {
              entry.level = raw;
            }
            break;
          default:
            break;
        }
      }
      out.push(entry);
    }
    return { nodes: out };
  });
}

// Evaluate an arbitrary expression via CDP Runtime.evaluate and return a
// JSON-serialized, length-capped representation of the result. This is a
// last-resort escape hatch; the gateway gates it behind an explicit grant.
async function evaluateInTab(tabId, expression, awaitPromise) {
  return withDebugger(tabId, async (debuggee) => {
    const evaluation = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: awaitPromise !== false,
      userGesture: true,
      timeout: 10_000,
    });
    if (evaluation?.exceptionDetails) {
      throw new Error(
        evaluation.exceptionDetails.exception?.description
        || evaluation.exceptionDetails.text
        || 'browser_evaluate_failed',
      );
    }
    const remote = evaluation?.result ?? {};
    let json;
    try {
      if (Object.prototype.hasOwnProperty.call(remote, 'value')) {
        json = JSON.stringify(remote.value);
      } else if (typeof remote.unserializableValue === 'string') {
        json = remote.unserializableValue;
      } else if (typeof remote.description === 'string') {
        json = remote.description;
      }
    } catch (error) {
      void error;
      json = typeof remote.description === 'string' ? remote.description : '';
    }
    const truncated = typeof json === 'string' && json.length > 20_000;
    return {
      ...(typeof remote.type === 'string' ? { type: remote.type } : {}),
      ...(typeof json === 'string' ? { json: json.slice(0, 20_000) } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  });
}

function resolveFileInputScript(selector) {
  function deepQuerySelector(targetSelector, root = document) {
    const direct = root.querySelector?.(targetSelector);
    if (direct) {
      return direct;
    }
    const nodes = root.querySelectorAll?.('*') ?? [];
    for (const node of nodes) {
      if (!node.shadowRoot) {
        continue;
      }
      const found = deepQuerySelector(targetSelector, node.shadowRoot);
      if (found) {
        return found;
      }
    }
    return null;
  }
  const element = deepQuerySelector(selector);
  if (!element || element.tagName !== 'INPUT' || element.type !== 'file') {
    throw new Error(`No file input matches selector: ${selector}`);
  }
  return element;
}

function waitForNextDownloadComplete(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('browser_download_timeout'));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timeout);
      chrome.downloads.onCreated.removeListener(onCreated);
    }
    function onCreated(item) {
      cleanup();
      waitForDownloadComplete(item.id, timeoutMs).then(resolve, reject);
    }
    chrome.downloads.onCreated.addListener(onCreated);
  });
}

function waitForDownloadComplete(downloadId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('browser_download_timeout'));
    }, timeoutMs);
    async function cleanup() {
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
    }
    async function finish() {
      cleanup();
      const items = await chrome.downloads.search({ id: downloadId });
      const item = items[0];
      if (!item) {
        reject(new Error('browser_download_not_found'));
        return;
      }
      if (item.state === 'interrupted') {
        reject(new Error(item.error || 'browser_download_interrupted'));
        return;
      }
      resolve(downloadItemPayload(item));
    }
    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state?.current) {
        return;
      }
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        void finish();
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }).then((items) => {
      const item = items[0];
      if (item?.state === 'complete' || item?.state === 'interrupted') {
        void finish();
      }
    }).catch(reject);
  });
}

function downloadItemPayload(item) {
  return {
    id: item.id,
    url: item.url,
    finalUrl: item.finalUrl,
    filename: item.filename,
    mime: item.mime,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    state: item.state,
    startedAt: item.startTime,
    endedAt: item.endTime,
  };
}

function sanitizeDownloadFilename(value) {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').includes('..')) {
    throw new Error('Invalid suggested download filename.');
  }
  return normalized;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function runInTargetTab(command, action, args) {
  assertGatewayEnabled();
  const tabId = requireTargetTabId(command);
  await startControlledTab(tabId);
  try {
    // Inject into every frame so elements inside <iframe>s are reachable. Each
    // frame returns a not-found sentinel when it lacks the element; we merge and
    // pick whichever frame actually matched.
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: pageBridgeScript,
      args: [action, args],
    });
    const frameResults = (injectionResults ?? [])
      .map((entry) => entry?.result)
      .filter((value) => value != null);
    const merged = mergeFrameResults(action, frameResults, args);
    await reportTab(await chrome.tabs.get(tabId));
    return merged;
  } finally {
    await stopControlledTab(tabId);
  }
}

// Reduce per-frame page-bridge results to a single value. For mutating actions
// this also enforces that the selector matched in at least one frame, so the
// gateway reports failure (#10) instead of a misleading success when nothing
// was clicked/typed.
function mergeFrameResults(action, frameResults, args) {
  if (action === 'query_elements') {
    const limit = typeof args?.[1] === 'number' ? args[1] : 50;
    const elements = [];
    for (const result of frameResults) {
      if (result && Array.isArray(result.elements)) {
        elements.push(...result.elements);
      }
    }
    return { elements: elements.slice(0, Math.max(1, Math.min(limit, 100))) };
  }

  if (action === 'fill_form') {
    const fields = Array.isArray(args?.[0]) ? args[0] : [];
    const merged = fields.map((field, index) => {
      for (const result of frameResults) {
        const perField = result && Array.isArray(result.__fields) ? result.__fields[index] : undefined;
        if (perField?.invalid) {
          throw new Error('Invalid form field selector.');
        }
        if (perField?.__found) {
          const { __found, ...rest } = perField;
          return rest;
        }
      }
      throw new Error(`No element matches selector: ${field?.selector ?? '(unknown)'}`);
    });
    return merged;
  }

  // click / type / select: take the first frame that found the element.
  const hit = frameResults.find((result) => result && result.__found === true);
  if (hit) {
    const { __found, ...rest } = hit;
    return rest;
  }
  const selector = typeof args?.[0] === 'string' ? args[0] : '(unknown)';
  throw new Error(`No element matches selector: ${selector}`);
}

// Poll every frame for a selector until it appears or the timeout elapses.
// Polling (rather than a per-frame MutationObserver) avoids blocking on frames
// that never contain the selector, which would otherwise hold the whole call
// open until the timeout on every navigation.
async function waitForSelectorAcrossFrames(tabId, selector, timeoutMs) {
  assertGatewayEnabled();
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const pollIntervalMs = 250;
  for (;;) {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: pageBridgeScript,
      args: ['find', [selector]],
    }).catch(() => []);
    const hit = (injectionResults ?? [])
      .map((entry) => entry?.result)
      .find((value) => value && value.__found === true);
    if (hit) {
      await reportTab(await chrome.tabs.get(tabId));
      const { __found, ...rest } = hit;
      return rest;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for selector: ${selector}`);
    }
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

async function buildTabPayload(tab, options = {}) {
  if (!isWebTab(tab)) {
    throw new Error('Chrome tab is not an http(s) page.');
  }
  const page = options.includeText
    ? await capturePageText(tab.id).catch(() => ({ title: tab.title, text: '' }))
    : { title: tab.title, text: '' };
  const screenshotBase64 = options.includeScreenshot
    ? await captureTabScreenshot(tab.id, { fullPage: false }).catch(() => undefined)
    : undefined;

  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: page.title || tab.title || tab.url,
    text: page.text || '',
    ...(screenshotBase64 ? { screenshotBase64 } : {}),
    capturedAt: Date.now(),
  };
}

async function capturePageText(tabId) {
  assertGatewayEnabled();
  // Inject into every frame so iframe content (e.g. portals embedded in an
  // <iframe>) is included instead of only the top frame's header/footer.
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: pageBridgeScript,
    args: ['snapshot', []],
  }).catch(() => []);

  let title = '';
  const texts = [];
  for (const entry of results ?? []) {
    const value = entry?.result;
    if (!value || typeof value !== 'object') {
      continue;
    }
    // The top frame is reported first, so prefer its document.title.
    if (!title && typeof value.title === 'string' && value.title) {
      title = value.title;
    }
    if (typeof value.text === 'string' && value.text) {
      texts.push(value.text);
    }
  }
  return { title, text: texts.join('\n').slice(0, 120000) };
}

const SCREENSHOT_DEFAULT_MAX_WIDTH = 1280;
const SCREENSHOT_DEFAULT_QUALITY = 60;
const SCREENSHOT_MAX_DIMENSION = 8192;

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function readLayoutSize(metrics, fullPage) {
  if (!metrics || typeof metrics !== 'object') {
    return null;
  }
  if (fullPage) {
    const content = metrics.cssContentSize || metrics.contentSize;
    if (content && content.width > 0 && content.height > 0) {
      return { width: Math.ceil(content.width), height: Math.ceil(content.height) };
    }
  }
  const viewport = metrics.cssLayoutViewport || metrics.layoutViewport;
  if (viewport && viewport.clientWidth > 0 && viewport.clientHeight > 0) {
    return { width: Math.ceil(viewport.clientWidth), height: Math.ceil(viewport.clientHeight) };
  }
  return null;
}

function computeDownscale(width, height, maxWidth, maxHeight) {
  let scale = 1;
  if (maxWidth && width > maxWidth) {
    scale = Math.min(scale, maxWidth / width);
  }
  if (maxHeight && height > maxHeight) {
    scale = Math.min(scale, maxHeight / height);
  }
  return scale > 0 && scale <= 1 ? scale : 1;
}

// Capture via the DevTools protocol so the screenshot does not depend on the
// tab being the active/focused tab of a focused OS window. Defaults to a
// downscaled JPEG so the base64 payload stays within the MCP inline budget.
async function captureTabScreenshot(tabId, options = {}) {
  assertGatewayEnabled();
  if (typeof tabId !== 'number') {
    throw new Error('Browser screenshot requires a Chrome tab id.');
  }
  const format = options.format === 'png' ? 'png' : 'jpeg';
  const quality = clampNumber(options.quality, 1, 100, SCREENSHOT_DEFAULT_QUALITY);
  const fullPage = options.fullPage === true;
  const maxWidth = clampNumber(options.maxWidth, 1, SCREENSHOT_MAX_DIMENSION, SCREENSHOT_DEFAULT_MAX_WIDTH);
  const maxHeight = clampNumber(options.maxHeight, 1, SCREENSHOT_MAX_DIMENSION, undefined);

  return withDebugger(tabId, async (debuggee) => {
    const metrics = await chrome.debugger
      .sendCommand(debuggee, 'Page.getLayoutMetrics')
      .catch(() => null);

    const params = {
      format,
      fromSurface: true,
      captureBeyondViewport: fullPage,
    };
    if (format === 'jpeg') {
      params.quality = quality;
    }

    const layout = readLayoutSize(metrics, fullPage);
    if (layout) {
      params.clip = {
        x: 0,
        y: 0,
        width: layout.width,
        height: layout.height,
        scale: computeDownscale(layout.width, layout.height, maxWidth, maxHeight),
      };
    }

    const shot = await chrome.debugger.sendCommand(debuggee, 'Page.captureScreenshot', params);
    const data = shot?.data;
    if (typeof data !== 'string' || !data) {
      throw new Error('Browser screenshot capture returned no image data.');
    }
    return data;
  });
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  if (typeof tabId !== 'number') {
    return;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === 'complete') {
    return;
  }
  await new Promise((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        done();
      }
    }
    function done() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function startControlledTab(tabId) {
  assertGatewayEnabled();
  if (typeof tabId !== 'number') {
    return;
  }
  await Promise.all([
    preventTabDiscard(tabId),
    markControlledTabGroup(tabId),
    installControlGlow(tabId),
    installConsoleNetworkCapture(tabId),
  ]);
}

// Keep Chrome's Memory Saver from freezing/discarding a tab we are actively
// driving. A discarded/frozen tab loses its renderer (and debugger target),
// which silently times out subsequent commands. autoDiscardable is a persistent
// per-tab flag that survives between commands — unlike the CDP focus/lifecycle
// overrides in applyDebuggerKeepAlive(), which reset when the debugger detaches.
// Intentionally not restored on stopControlledTab: a tab the user shared with
// Harness should stay alive across the whole session, and the discard risk is
// highest precisely when the tab sits idle between commands.
async function preventTabDiscard(tabId) {
  if (typeof tabId !== 'number' || !chrome.tabs?.update) {
    return;
  }
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => undefined);
}

async function stopControlledTab(tabId) {
  if (typeof tabId !== 'number') {
    return;
  }
  await removeControlGlow(tabId);
}

async function markControlledTabGroup(tabId) {
  if (!chrome.tabs?.group || !chrome.tabGroups?.update) {
    return;
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    return;
  }
  const noGroupId = chrome.tabGroups.TAB_GROUP_ID_NONE ?? -1;
  const currentGroupId = typeof tab.groupId === 'number' ? tab.groupId : noGroupId;

  // Reuse the single canonical "Harness" control group in this tab's
  // window so every controlled tab collapses into one group instead of spawning
  // a new group per tab. Tab groups are window-scoped, so this is constrained to
  // the tab's own window. The canonical group is the oldest matching group
  // (smallest id), which is deterministic and lets a tab stuck in a stale
  // duplicate group migrate back into the shared one when re-controlled.
  const canonicalGroupId = await findControlGroupId(tab.windowId, noGroupId);

  // Already homed in the canonical control group — nothing to (re)group.
  if (currentGroupId !== noGroupId && currentGroupId === canonicalGroupId) {
    return;
  }

  const groupId = await chrome.tabs.group(
    canonicalGroupId !== noGroupId
      ? { tabIds: tabId, groupId: canonicalGroupId }
      : { tabIds: tabId },
  ).catch(() => noGroupId);

  if (typeof groupId === 'number' && groupId !== noGroupId) {
    await chrome.tabGroups.update(groupId, {
      title: CONTROL_GROUP_TITLE,
      color: 'blue',
      collapsed: false,
    }).catch(() => undefined);
  }
}

async function findControlGroupId(windowId, noGroupId) {
  if (!chrome.tabGroups?.query) {
    return noGroupId;
  }
  const query = typeof windowId === 'number'
    ? { windowId, title: CONTROL_GROUP_TITLE }
    : { title: CONTROL_GROUP_TITLE };
  const groups = await chrome.tabGroups.query(query).catch(() => []);
  // Pick the oldest matching group (smallest id) so the canonical group is
  // stable regardless of query ordering, avoiding group-thrash when multiple
  // tabs are controlled at once.
  let canonicalId = noGroupId;
  for (const group of groups) {
    if (typeof group?.id !== 'number') {
      continue;
    }
    if (canonicalId === noGroupId || group.id < canonicalId) {
      canonicalId = group.id;
    }
  }
  return canonicalId;
}

// Console/network capture for shared, extension-driven tabs.
//
// The gateway's snapshot/click/etc. attach the CDP debugger transiently
// (attach → run → detach), so there is no persistent CDP session to hang a
// Runtime/Network/Log listener on, and in MV3 the service worker is killed on
// idle — a persistent chrome.debugger attach would drop its buffer and re-flash
// the "started debugging this browser" banner on every wake. Instead we install
// a lightweight buffer in the page's own MAIN world that wraps console.error/
// warn, window error / unhandledrejection, and fetch/XMLHttpRequest. It lives on
// the page's window, so it survives in-page (SPA history) navigations — an
// Angular route change does NOT wipe it (console-read prompt, req #2) — and only
// resets on a full document load, at which point the next controlled-tab command
// re-installs it. Install is idempotent and cheap, so running it on every
// startControlledTab is safe.
async function installConsoleNetworkCapture(tabId) {
  assertGatewayEnabled();
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: installCaptureScript,
  }).catch(() => undefined);
}

// Read the MAIN-world capture buffer for a controlled tab. startControlledTab
// (re)installs the buffer first, so this is lazy — it never requires the user to
// re-share the tab (req #5). Returns { kind, installed, entries }.
async function readCapturedEntries(command, kind) {
  const tabId = requireTargetTabId(command);
  await startControlledTab(tabId);
  try {
    const sinceSeq = typeof command.payload?.sinceSeq === 'number' ? command.payload.sinceSeq : null;
    const level = typeof command.payload?.level === 'string' ? command.payload.level : null;
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: readCaptureScript,
      args: [kind, sinceSeq, level],
    }).catch(() => []);
    const value = (results && results[0] && results[0].result) || null;
    const installed = Boolean(value && value.installed);
    const entries = value && Array.isArray(value.entries) ? value.entries : [];
    return { kind, installed, entries };
  } finally {
    await stopControlledTab(tabId);
  }
}

// Injected into the page MAIN world. Self-contained (no closure over extension
// scope). Idempotent: re-invocation on an already-instrumented document is a
// no-op. Buffers are bounded and text is clipped in-page; the gateway redacts
// again on the way out.
function installCaptureScript() {
  const KEY = '__harnessBrowserCapture';
  if (window[KEY] && window[KEY].installed) {
    return { installed: true, already: true };
  }
  const MAX_ENTRIES = 300;
  const MAX_TEXT = 4000;
  const state = {
    installed: true,
    seq: 0,
    console: [],
    network: [],
  };
  window[KEY] = state;

  const clip = (value) => {
    let text;
    try {
      if (typeof value === 'string') {
        text = value;
      } else if (value && typeof value === 'object') {
        try {
          text = JSON.stringify(value);
        } catch (_e) {
          text = String(value);
        }
      } else {
        text = String(value);
      }
    } catch (_e) {
      text = '[unserializable]';
    }
    if (typeof text !== 'string') {
      text = String(text);
    }
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…[truncated]' : text;
  };
  const formatArgs = (args) => {
    try {
      return Array.prototype.map.call(args, (arg) => {
        if (typeof arg === 'string') {
          return arg;
        }
        if (arg instanceof Error) {
          return arg.stack || (arg.name + ': ' + arg.message);
        }
        return clip(arg);
      }).join(' ');
    } catch (_e) {
      return '[uncapturable console arguments]';
    }
  };
  const push = (bucket, entry) => {
    entry.seq = state.seq++;
    entry.timestamp = Date.now();
    bucket.push(entry);
    if (bucket.length > MAX_ENTRIES) {
      bucket.splice(0, bucket.length - MAX_ENTRIES);
    }
  };

  // Console: capture error + warning only (bounds noise; matches req #2).
  ['error', 'warn'].forEach((level) => {
    const original = console[level];
    if (typeof original !== 'function') {
      return;
    }
    console[level] = function () {
      try {
        push(state.console, { type: level, text: clip(formatArgs(arguments)) });
      } catch (_e) {
        // Never let capture break the page's own logging.
      }
      return original.apply(this, arguments);
    };
  });

  // Uncaught errors — includes resource load failures (img/script/link), which
  // arrive with a DOM element target and no message.
  window.addEventListener('error', (event) => {
    try {
      const target = event && event.target;
      if (target && target !== window && target.tagName) {
        const url = target.src || target.href || '';
        push(state.network, {
          method: 'GET',
          url: clip(url),
          resourceType: String(target.tagName || '').toLowerCase(),
          status: 0,
          failureText: 'resource failed to load',
        });
        return;
      }
      push(state.console, {
        type: 'error',
        text: clip((event && event.message) || 'Uncaught error'),
        location: {
          url: (event && event.filename) || undefined,
          lineNumber: event && typeof event.lineno === 'number' ? event.lineno : undefined,
          columnNumber: event && typeof event.colno === 'number' ? event.colno : undefined,
        },
        stack: event && event.error && event.error.stack ? clip(event.error.stack) : undefined,
      });
    } catch (_e) {
      // ignore
    }
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event && event.reason;
      const message = reason && reason.message ? reason.message : reason;
      push(state.console, {
        type: 'error',
        text: clip('Unhandled promise rejection: ' + clip(message)),
        stack: reason && reason.stack ? clip(reason.stack) : undefined,
      });
    } catch (_e) {
      // ignore
    }
  });

  // fetch — records method, url, status, ok, failure text, duration.
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      let url = '';
      let method = 'GET';
      try {
        if (typeof input === 'string') {
          url = input;
        } else if (input && typeof input === 'object') {
          url = input.url || '';
          method = input.method || method;
        }
        if (init && init.method) {
          method = init.method;
        }
      } catch (_e) {
        // ignore
      }
      const started = Date.now();
      let promise;
      try {
        promise = originalFetch.apply(this, arguments);
      } catch (syncError) {
        push(state.network, {
          method: String(method).toUpperCase(),
          url: clip(url),
          resourceType: 'fetch',
          status: 0,
          failureText: clip(syncError && syncError.message ? syncError.message : String(syncError)),
          durationMs: Date.now() - started,
        });
        throw syncError;
      }
      return promise.then((response) => {
        try {
          push(state.network, {
            method: String(method).toUpperCase(),
            url: clip(url),
            resourceType: 'fetch',
            status: typeof response.status === 'number' ? response.status : undefined,
            statusText: response.statusText || undefined,
            ok: response.ok === true,
            durationMs: Date.now() - started,
          });
        } catch (_e) {
          // ignore
        }
        return response;
      }, (error) => {
        try {
          push(state.network, {
            method: String(method).toUpperCase(),
            url: clip(url),
            resourceType: 'fetch',
            status: 0,
            failureText: clip(error && error.message ? error.message : String(error)),
            durationMs: Date.now() - started,
          });
        } catch (_e) {
          // ignore
        }
        throw error;
      });
    };
  }

  // XMLHttpRequest — capture status/failure on loadend.
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function') {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try {
        this.__harnessMethod = method;
        this.__harnessUrl = url;
        this.__harnessStarted = Date.now();
      } catch (_e) {
        // ignore
      }
      return originalOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      try {
        const xhr = this;
        xhr.addEventListener('loadend', () => {
          try {
            const status = typeof xhr.status === 'number' ? xhr.status : 0;
            const failed = status === 0;
            push(state.network, {
              method: String(xhr.__harnessMethod || 'GET').toUpperCase(),
              url: clip(xhr.__harnessUrl || (typeof xhr.responseURL === 'string' ? xhr.responseURL : '')),
              resourceType: 'xhr',
              status,
              statusText: xhr.statusText || undefined,
              ok: status >= 200 && status < 400,
              failureText: failed ? 'request failed or was aborted' : undefined,
              durationMs: typeof xhr.__harnessStarted === 'number' ? Date.now() - xhr.__harnessStarted : undefined,
            });
          } catch (_e) {
            // ignore
          }
        });
      } catch (_e) {
        // ignore
      }
      return originalSend.apply(this, arguments);
    };
  }

  // PerformanceObserver — status codes for EVERY resource type (img, script,
  // css, link, media, …), which the fetch/XHR wrappers alone miss. `buffered:
  // true` also backfills resources that loaded before this hook installed, so a
  // read right after a fresh load still sees them. fetch/xmlhttprequest are left
  // to the wrappers above (richer: request method + failure text), so we skip
  // those initiator types here to avoid double-counting. `responseStatus`
  // (Chrome 109+) is 0 for cross-origin resources without Timing-Allow-Origin —
  // recorded as unknown, not a failure.
  if (typeof PerformanceObserver === 'function') {
    try {
      const seenResource = new Set();
      const observer = new PerformanceObserver((list) => {
        try {
          list.getEntries().forEach((entry) => {
            try {
              const initiator = String(entry.initiatorType || 'other');
              if (initiator === 'fetch' || initiator === 'xmlhttprequest') {
                return;
              }
              // Dedupe: buffered flush + live callbacks can repeat an entry.
              const key = initiator + ' ' + String(entry.name || '') + ' ' + String(entry.startTime || 0);
              if (seenResource.has(key)) {
                return;
              }
              seenResource.add(key);
              const hasStatus = typeof entry.responseStatus === 'number' && entry.responseStatus > 0;
              push(state.network, {
                method: 'GET',
                url: clip(entry.name || ''),
                resourceType: initiator,
                status: hasStatus ? entry.responseStatus : undefined,
                ok: hasStatus ? entry.responseStatus >= 200 && entry.responseStatus < 400 : undefined,
                failureText: hasStatus && entry.responseStatus >= 400
                  ? 'resource returned an error status'
                  : undefined,
                durationMs: typeof entry.duration === 'number' ? Math.round(entry.duration) : undefined,
              });
            } catch (_e) {
              // ignore a single malformed entry
            }
          });
        } catch (_e) {
          // ignore
        }
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch (_e) {
      // PerformanceObserver('resource') unsupported — fetch/XHR wrappers + the
      // resource-error listener still cover the common cases.
    }
  }

  return { installed: true, already: false };
}

// Injected into the page MAIN world to read the buffer. Optional sinceSeq
// returns only entries newer than a previously-seen sequence; optional level
// filters console entries by type.
function readCaptureScript(kind, sinceSeq, level) {
  const state = window['__harnessBrowserCapture'];
  if (!state || !state.installed) {
    return { installed: false, entries: [] };
  }
  const source = kind === 'network' ? state.network : state.console;
  let entries = Array.isArray(source) ? source.slice() : [];
  if (typeof sinceSeq === 'number') {
    entries = entries.filter((entry) => typeof entry.seq === 'number' && entry.seq > sinceSeq);
  }
  if (kind !== 'network' && typeof level === 'string' && level) {
    entries = entries.filter((entry) => entry.type === level);
  }
  return { installed: true, entries: entries.slice(-200) };
}

async function installControlGlow(tabId) {
  assertGatewayEnabled();
  await chrome.scripting.executeScript({
    target: { tabId },
    func: installControlGlowScript,
  }).catch(() => undefined);
}

async function removeControlGlow(tabId) {
  assertGatewayEnabled();
  await chrome.scripting.executeScript({
    target: { tabId },
    func: removeControlGlowScript,
  }).catch(() => undefined);
}

function installControlGlowScript() {
  const styleId = 'aio-browser-control-glow-style';
  const elementId = 'aio-browser-control-glow';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes aio-browser-control-glow-pulse {
        0%, 100% {
          opacity: 0.82;
          box-shadow:
            inset 0 0 28px 7px rgba(37, 99, 235, 0.52),
            inset 0 0 8px 2px rgba(147, 197, 253, 0.9);
        }
        50% {
          opacity: 1;
          box-shadow:
            inset 0 0 42px 10px rgba(37, 99, 235, 0.7),
            inset 0 0 12px 3px rgba(147, 197, 253, 0.95);
        }
      }

      #aio-browser-control-glow {
        position: fixed;
        inset: 0;
        border: 2px solid rgba(96, 165, 250, 0.95);
        pointer-events: none;
        z-index: 2147483647;
        animation: aio-browser-control-glow-pulse 1.6s ease-in-out infinite;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  if (!document.getElementById(elementId)) {
    const glow = document.createElement('div');
    glow.id = elementId;
    glow.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(glow);
  }
}

function removeControlGlowScript() {
  document.getElementById('aio-browser-control-glow')?.remove();
}

function pageBridgeScript(action, args) {
  function deepQuerySelector(selector, root = document) {
    const direct = root.querySelector?.(selector);
    if (direct) {
      return direct;
    }
    const nodes = root.querySelectorAll?.('*') ?? [];
    for (const node of nodes) {
      if (!node.shadowRoot) {
        continue;
      }
      const found = deepQuerySelector(selector, node.shadowRoot);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function collectVisibleText(root = document, seen = new Set()) {
    if (!root || seen.has(root)) {
      return '';
    }
    seen.add(root);
    const parts = [];
    if (root === document) {
      parts.push(document.body?.innerText || '');
    } else {
      parts.push(root.textContent || '');
    }
    const nodes = root.querySelectorAll?.('*') ?? [];
    for (const node of nodes) {
      if (node.shadowRoot) {
        parts.push(collectVisibleText(node.shadowRoot, seen));
      }
    }
    return parts
      .map((part) => String(part).trim())
      .filter(Boolean)
      .join('\n');
  }

  function requireElement(selector) {
    const element = deepQuerySelector(selector);
    if (!element) {
      throw new Error(`No element matches selector: ${selector}`);
    }
    return element;
  }

  function describeElement(element) {
    return {
      tagName: element.tagName,
      text: (element.innerText || element.textContent || '').slice(0, 1000),
      value: typeof element.value === 'string' ? element.value.slice(0, 1000) : undefined,
    };
  }

  // React (and other controlled inputs) track the *native* value setter, so a
  // plain `element.value = ...` assignment is dropped. Call the prototype setter
  // directly so the framework's value tracker observes the change.
  function setNativeValue(element, value) {
    const prototype = typeof HTMLTextAreaElement !== 'undefined' && element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : typeof HTMLInputElement !== 'undefined' && element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : typeof HTMLSelectElement !== 'undefined' && element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : null;
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  // Synthetic element.click() is ignored by many SPA/web-component controls that
  // only react to a real pointer/mouse sequence. Dispatch the full sequence so
  // those controls (and React's delegated click listener) fire.
  function dispatchRealClick(element) {
    const rect = element.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const mouseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      button: 0,
    };
    const pointerInit = {
      ...mouseInit,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      width: 1,
      height: 1,
    };
    try {
      element.focus?.();
    } catch {
      // Some elements are not focusable; ignore.
    }
    const PointerEventCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    element.dispatchEvent(new PointerEventCtor('pointerover', { ...pointerInit, buttons: 0 }));
    element.dispatchEvent(new PointerEventCtor('pointerenter', { ...pointerInit, bubbles: false, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('mouseover', { ...mouseInit, buttons: 0 }));
    element.dispatchEvent(new PointerEventCtor('pointerdown', { ...pointerInit, buttons: 1 }));
    element.dispatchEvent(new MouseEvent('mousedown', { ...mouseInit, buttons: 1 }));
    element.dispatchEvent(new PointerEventCtor('pointerup', { ...pointerInit, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
    // The dispatched click event drives the element's default activation
    // behaviour, so element.click() is intentionally NOT also called (that would
    // double-fire and cancel out toggles such as checkboxes).
    element.dispatchEvent(new MouseEvent('click', { ...mouseInit, buttons: 0 }));
  }

  // Non-throwing lookup used by per-frame action handlers: a frame that does not
  // contain the element returns a not-found sentinel instead of throwing, so the
  // background script can pick whichever frame actually matched.
  function findElement(selector) {
    return deepQuerySelector(selector);
  }

  function isVisible(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) {
      return false;
    }
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
    if (style && (style.visibility === 'hidden' || style.display === 'none')) {
      return false;
    }
    return true;
  }

  // Rich-text editors (Slate/Lexical/ProseMirror-style) keep their own model
  // in sync via native 'beforeinput'/'input' events; a bulk textContent
  // overwrite bypasses that and desyncs on the editor's next render. Select
  // the existing content and use execCommand('insertText', ...) so the
  // replacement travels through the same native editing pipeline a real
  // keystroke would, falling back to textContent only if that's unavailable.
  function fillContentEditable(element, value) {
    try {
      const selection = typeof window !== 'undefined' ? window.getSelection() : null;
      if (selection && typeof document !== 'undefined' && document.createRange) {
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const inserted = typeof document !== 'undefined'
        && typeof document.execCommand === 'function'
        && document.execCommand('insertText', false, value);
      if (!inserted) {
        element.textContent = value;
      }
    } catch (error) {
      void error;
      element.textContent = value;
    }
  }

  function applyType(element, value) {
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    if (element.isContentEditable) {
      fillContentEditable(element, value);
    } else {
      setNativeValue(element, value);
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    const valueAfter = element.isContentEditable
      ? (element.textContent || '')
      : (typeof element.value === 'string' ? element.value : '');
    return {
      ...describeElement(element),
      // Evidence for callers (#10): masked/formatted inputs may legitimately
      // transform the value, so valueApplied is informational, not a hard check.
      valueAfter: String(valueAfter).slice(0, 1000),
      valueApplied: valueAfter === value,
      disabled: Boolean(element.disabled),
      readOnly: Boolean(element.readOnly),
    };
  }

  // Match an option for a custom (non-<select>) dropdown by visible text, then
  // by accessible name. Searches role=option/menuitem first, then list items.
  function findOptionByText(value) {
    const wanted = String(value).trim().toLowerCase();
    if (!wanted) {
      return null;
    }
    const optionSelector = '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="treeitem"],li,option';
    const candidates = [];
    const collect = (root) => {
      if (!root) {
        return;
      }
      for (const node of Array.from(root.querySelectorAll?.(optionSelector) ?? [])) {
        candidates.push(node);
      }
      for (const node of Array.from(root.querySelectorAll?.('*') ?? [])) {
        if (node.shadowRoot) {
          collect(node.shadowRoot);
        }
      }
    };
    collect(document);
    const visible = candidates.filter(isVisible);
    const exact = visible.find((node) =>
      (node.innerText || node.textContent || '').trim().toLowerCase() === wanted
      || (node.getAttribute?.('aria-label') ?? '').trim().toLowerCase() === wanted);
    if (exact) {
      return exact;
    }
    return visible.find((node) =>
      (node.innerText || node.textContent || '').trim().toLowerCase().includes(wanted)) ?? null;
  }

  function selectValue(element, value) {
    element.scrollIntoView({ block: 'center', inline: 'center' });
    // Native <select>: match by value, then label, then visible option text.
    if (element.tagName === 'SELECT') {
      element.focus();
      const options = Array.from(element.options || []);
      const match = options.find((option) => option.value === value)
        || options.find((option) => (option.label || '').trim() === String(value).trim())
        || options.find((option) => (option.textContent || '').trim().toLowerCase() === String(value).trim().toLowerCase());
      setNativeValue(element, match ? match.value : value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ...describeElement(element),
        selectedValue: typeof element.value === 'string' ? element.value : undefined,
        matchedOption: match ? (match.label || match.textContent || match.value || '').trim().slice(0, 200) : null,
      };
    }

    // Custom dropdown: open it, then wait briefly for async-rendered options.
    dispatchRealClick(element);
    return new Promise((resolve) => {
      const deadline = Date.now() + 2000;
      const attempt = () => {
        const option = findOptionByText(value);
        if (option) {
          dispatchRealClick(option);
          resolve({
            ...describeElement(element),
            selectedOption: (option.innerText || option.textContent || '').trim().slice(0, 200),
            matchedOption: (option.innerText || option.textContent || '').trim().slice(0, 200),
          });
          return;
        }
        if (Date.now() >= deadline) {
          resolve({
            ...describeElement(element),
            selectedOption: null,
            matchedOption: null,
            note: 'custom_select_option_not_found',
          });
          return;
        }
        setTimeout(attempt, 100);
      };
      attempt();
    });
  }

  function cssAttr(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function cssIdent(value) {
    return CSS?.escape?.(value) ?? cssAttr(value);
  }

  function countMatches(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  }

  function tagName(element) {
    return (element.tagName || 'div').toLowerCase();
  }

  function childIndex(element) {
    const siblings = Array.from(element.parentElement?.children ?? []);
    const sameTagBefore = siblings
      .slice(0, siblings.indexOf(element))
      .filter((item) => tagName(item) === tagName(element));
    return sameTagBefore.length + 1;
  }

  function selectorForElement(element) {
    if (element.id) {
      const byId = `#${cssIdent(element.id)}`;
      if (countMatches(byId) === 1) {
        return byId;
      }
      const byIdAttr = `[id="${cssAttr(element.id)}"]`;
      if (countMatches(byIdAttr) === 1) {
        return byIdAttr;
      }
    }

    for (const attr of ['data-testid', 'data-test', 'aria-label', 'name', 'title']) {
      const value = element.getAttribute?.(attr);
      if (!value) {
        continue;
      }
      const selector = `${tagName(element)}[${attr}="${cssAttr(value)}"]`;
      if (countMatches(selector) === 1) {
        return selector;
      }
    }

    const segments = [];
    let current = element;
    for (let depth = 0; current && current !== document.body && depth < 5; depth++) {
      const segment = `${tagName(current)}:nth-of-type(${childIndex(current)})`;
      segments.unshift(segment);
      const selector = segments.join(' > ');
      if (countMatches(selector) === 1) {
        return selector;
      }
      current = current.parentElement;
    }
    return segments.join(' > ') || tagName(element);
  }

  function elementText(element) {
    return (element.innerText || element.textContent || '').trim().slice(0, 1000);
  }

  function candidateText(element) {
    return [
      elementText(element),
      element.getAttribute?.('aria-label') ?? '',
      element.getAttribute?.('title') ?? '',
      element.getAttribute?.('placeholder') ?? '',
      element.getAttribute?.('name') ?? '',
      element.getAttribute?.('data-testid') ?? '',
      element.id ?? '',
    ].join(' ').toLowerCase();
  }

  function collectCandidateElements(root = document) {
    const selector = [
      'a',
      'button',
      'input',
      'select',
      'textarea',
      '[role]',
      '[aria-label]',
      '[title]',
      '[data-testid]',
      '[contenteditable="true"]',
    ].join(',');
    const direct = Array.from(root.querySelectorAll?.(selector) ?? []);
    const nested = [];
    for (const node of Array.from(root.querySelectorAll?.('*') ?? [])) {
      if (node.shadowRoot) {
        nested.push(...collectCandidateElements(node.shadowRoot));
      }
    }
    return [...direct, ...nested];
  }

  // Read back the current state of a form control so the agent can verify
  // dropdowns, checkboxes, and inputs without acting. Native <select>s expose
  // value + selected option label + the full option list; password values are
  // never surfaced.
  function controlState(element) {
    const state = {};
    const tag = (element.tagName || '').toUpperCase();
    const type = (element.type || '').toLowerCase();
    if (tag === 'SELECT') {
      const options = Array.from(element.options || []);
      if (typeof element.value === 'string') {
        state.value = element.value.slice(0, 1000);
      }
      const selectedLabel = options
        .filter((option) => option.selected)
        .map((option) => (option.label || option.textContent || option.value || '').trim())
        .filter(Boolean)
        .join(', ');
      if (selectedLabel) {
        state.selectedOption = selectedLabel.slice(0, 200);
      }
      state.options = options.slice(0, 50).map((option) => ({
        value: String(option.value ?? '').slice(0, 200),
        label: (option.label || option.textContent || '').trim().slice(0, 200),
        selected: Boolean(option.selected),
      }));
    } else if (type === 'checkbox' || type === 'radio') {
      state.checked = Boolean(element.checked);
      if (typeof element.value === 'string' && element.value && element.value !== 'on') {
        state.value = element.value.slice(0, 200);
      }
    } else if (type === 'password') {
      // Never surface secret input values to the agent.
    } else if (typeof element.value === 'string') {
      state.value = element.value.slice(0, 1000);
    } else if (element.isContentEditable) {
      state.value = (element.textContent || '').slice(0, 1000);
    }

    if (element.disabled === true) {
      state.disabled = true;
    }
    const ariaExpanded = element.getAttribute?.('aria-expanded');
    if (ariaExpanded === 'true' || ariaExpanded === 'false') {
      state.expanded = ariaExpanded === 'true';
    }
    const ariaChecked = element.getAttribute?.('aria-checked');
    if (state.checked === undefined && (ariaChecked === 'true' || ariaChecked === 'false')) {
      state.checked = ariaChecked === 'true';
    }
    return state;
  }

  function queryElements(query, limit) {
    const normalizedQuery = query?.trim().toLowerCase();
    const max = Math.max(1, Math.min(limit ?? 50, 100));
    const elements = collectCandidateElements()
      .filter((element) => !normalizedQuery || candidateText(element).includes(normalizedQuery))
      .slice(0, max)
      .map((element) => ({
        selector: selectorForElement(element).slice(0, 2000),
        tagName: element.tagName ?? tagName(element).toUpperCase(),
        role: element.getAttribute?.('role') ?? tagName(element),
        accessibleName:
          element.getAttribute?.('aria-label') ??
          element.getAttribute?.('title') ??
          element.getAttribute?.('name') ??
          undefined,
        text: elementText(element),
        inputType: element.type,
        placeholder: element.placeholder,
        href: element.href,
        ...controlState(element),
      }));
    return { elements };
  }

  if (action === 'snapshot') {
    return {
      title: document.title,
      text: collectVisibleText().slice(0, 120000),
    };
  }

  if (action === 'query_elements') {
    const [query, limit] = args;
    return queryElements(query, limit);
  }

  if (action === 'read_control') {
    const [selector] = args;
    const element = findElement(selector);
    if (!element) {
      return { __found: false };
    }
    const state = controlState(element);
    return {
      __found: true,
      value: state.value,
      selectedLabel: state.selectedOption,
      checked: state.checked,
    };
  }

  // Per-frame existence probe used by the background all-frames wait_for poll.
  if (action === 'find') {
    const [selector] = args;
    const element = findElement(selector);
    return element
      ? { __found: true, ...describeElement(element) }
      : { __found: false };
  }

  if (action === 'click') {
    const [selector] = args;
    const element = findElement(selector);
    if (!element) {
      return { __found: false };
    }
    element.scrollIntoView({ block: 'center', inline: 'center' });
    dispatchRealClick(element);
    return {
      __found: true,
      ...describeElement(element),
      disabled: Boolean(element.disabled),
      connected: element.isConnected !== false,
    };
  }

  if (action === 'type') {
    const [selector, value] = args;
    const element = findElement(selector);
    if (!element) {
      return { __found: false };
    }
    return { __found: true, ...applyType(element, value) };
  }

  if (action === 'fill_form') {
    const [fields] = args;
    const fieldResults = (Array.isArray(fields) ? fields : []).map((field) => {
      if (!field || typeof field.selector !== 'string') {
        return { __found: false, invalid: true };
      }
      const element = findElement(field.selector);
      if (!element) {
        return { __found: false, selector: field.selector };
      }
      return { __found: true, selector: field.selector, ...applyType(element, String(field.value ?? '')) };
    });
    return { __fields: fieldResults };
  }

  if (action === 'select') {
    const [selector, value] = args;
    const element = findElement(selector);
    if (!element) {
      return { __found: false };
    }
    return Promise.resolve(selectValue(element, value)).then((result) => ({
      __found: true,
      ...result,
    }));
  }

  throw new Error(`Unsupported page bridge action: ${action}`);
}

function requireTargetTabId(command) {
  const tabId = command.target?.tabId;
  if (typeof tabId !== 'number') {
    throw new Error('Browser command is missing a Chrome tab id.');
  }
  return tabId;
}

function requirePayloadString(command, key) {
  const value = command.payload?.[key];
  if (typeof value !== 'string') {
    throw new Error(`Browser command payload is missing ${key}.`);
  }
  return value;
}

function isWebTab(tab) {
  return Boolean(
    tab
    && typeof tab.id === 'number'
    && typeof tab.windowId === 'number'
    && typeof tab.url === 'string'
    && /^https?:\/\//i.test(tab.url),
  );
}

function isTabPayload(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.tabId === 'number'
    && typeof value.windowId === 'number'
    && typeof value.url === 'string',
  );
}
