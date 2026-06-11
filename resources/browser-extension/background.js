const HOST_NAME = 'com.ai_orchestrator.browser_gateway';
const INVENTORY_ALARM = 'browser-gateway-inventory';
const POLL_TIMEOUT_MS = 10000;
const POLL_IDLE_DELAY_MS = 250;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const MAX_OUTBOX = 50;
const MAX_INVENTORY_TABS = 40;
const CONTROL_GROUP_TITLE = 'AI Orchestrator';

let nativePort = null;
let pollInFlight = false;
let inventoryInFlight = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
// Buffer for non-poll messages (command results, tab attachments) so a brief
// native-host disconnect does not silently drop them — they flush on reconnect.
const outbox = [];

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(INVENTORY_ALARM, { periodInMinutes: 1 });
  void startBridge();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(INVENTORY_ALARM, { periodInMinutes: 1 });
  void startBridge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== INVENTORY_ALARM) {
    return;
  }
  void reportTabInventory();
  pollForCommand();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isWebTab(tab) || (!changeInfo.url && !changeInfo.title && changeInfo.status !== 'complete')) {
    return;
  }
  void reportTab(tab);
});

chrome.tabs.onRemoved.addListener(() => {
  void reportTabInventory();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'share_active_tab') {
    return false;
  }

  shareActiveTab()
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  return true;
});

void startBridge();

async function startBridge() {
  connectNativePort();
  await reportTabInventory().catch(() => undefined);
  pollForCommand();
}

function reconnectDelayMs() {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
  // ±20% jitter so many extensions/tabs don't reconnect in lockstep.
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(RECONNECT_BASE_MS, Math.round(base + jitter));
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  const wait = reconnectDelayMs();
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startBridge().catch(() => undefined);
  }, wait);
}

function enqueueOutbox(message) {
  outbox.push(message);
  // Drop the oldest buffered messages if the host stays down for a long time.
  while (outbox.length > MAX_OUTBOX) {
    outbox.shift();
  }
}

function flushOutbox() {
  if (!nativePort || outbox.length === 0) {
    return;
  }
  const pending = outbox.splice(0, outbox.length);
  for (let index = 0; index < pending.length; index++) {
    try {
      nativePort.postMessage(pending[index]);
    } catch {
      // Re-buffer this and the remaining messages; the disconnect handler will
      // schedule another reconnect+flush.
      for (let rest = pending.length - 1; rest >= index; rest--) {
        outbox.unshift(pending[rest]);
      }
      nativePort = null;
      pollInFlight = false;
      scheduleReconnect();
      return;
    }
  }
}

function connectNativePort() {
  if (nativePort) {
    return nativePort;
  }
  nativePort = chrome.runtime.connectNative(HOST_NAME);
  nativePort.onMessage.addListener((message) => {
    // Inbound traffic means the channel is healthy again.
    reconnectAttempts = 0;
    void handleNativeMessage(message);
  });
  nativePort.onDisconnect.addListener(() => {
    // Read lastError so handled native-host disconnects do not surface as extension errors.
    void chrome.runtime.lastError?.message;
    nativePort = null;
    pollInFlight = false;
    scheduleReconnect();
  });
  flushOutbox();
  return nativePort;
}

function postNativeMessage(message) {
  // Poll requests are transient — never buffer/replay them (a stale poll would
  // just confuse the host). Everything else is queued if the channel is down.
  const isPoll = message?.type === 'poll_command';
  try {
    connectNativePort().postMessage(message);
  } catch {
    nativePort = null;
    pollInFlight = false;
    if (!isPoll) {
      enqueueOutbox(message);
    }
    scheduleReconnect();
  }
}

async function handleNativeMessage(message) {
  pollInFlight = false;
  if (!message || message.type !== 'browser_command') {
    scheduleNextPoll(POLL_IDLE_DELAY_MS);
    return;
  }
  if (!message.command) {
    scheduleNextPoll(POLL_IDLE_DELAY_MS);
    return;
  }

  const command = message.command;
  try {
    const result = await executeBrowserCommand(command);
    if (isTabPayload(result)) {
      postNativeMessage({ type: 'attach_tab', tab: result });
    }
    postNativeMessage({
      type: 'command_result',
      commandId: command.id,
      ok: true,
      result,
    });
  } catch (error) {
    postNativeMessage({
      type: 'command_result',
      commandId: command.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    scheduleNextPoll(0);
  }
}

function pollForCommand() {
  if (pollInFlight) {
    return;
  }
  pollInFlight = true;
  postNativeMessage({
    type: 'poll_command',
    timeoutMs: POLL_TIMEOUT_MS,
  });
}

function scheduleNextPoll(delayMs) {
  setTimeout(() => pollForCommand(), delayMs);
}

async function reportTabInventory() {
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
      postNativeMessage({
        type: 'tab_inventory',
        tabs: tabPayloads,
      });
    }
  } finally {
    inventoryInFlight = false;
  }
}

async function reportTab(tab) {
  if (!isWebTab(tab)) {
    return;
  }
  const payload = await buildTabPayload(tab, { includeText: true }).catch(() => null);
  if (!payload) {
    return;
  }
  postNativeMessage({
    type: 'attach_tab',
    tab: payload,
  });
}

async function shareActiveTab() {
  const tab = await findActiveWebTabForSharing();
  if (!isWebTab(tab)) {
    throw new Error('No active Chrome tab is available to share.');
  }

  const response = await sendNativeMessage({
    type: 'attach_tab',
    tab: await buildTabPayload(tab, {
      includeText: true,
      includeScreenshot: true,
    }),
  });

  return {
    ok: Boolean(response?.ok),
    response,
  };
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
  switch (command.command) {
    case 'open_tab': {
      const url = requirePayloadString(command, 'url');
      const tab = await chrome.tabs.create({ url, active: true });
      await startControlledTab(tab.id);
      try {
        await waitForTabComplete(tab.id);
        await installControlGlow(tab.id);
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
        await installControlGlow(tabId);
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
    default:
      throw new Error(`Unsupported browser command: ${command.command}`);
  }
}

async function uploadFileInTargetTab(command) {
  const tabId = requireTargetTabId(command);
  const selector = requirePayloadString(command, 'selector');
  const filePath = requirePayloadString(command, 'filePath');
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
      await chrome.debugger.sendCommand(debuggee, 'DOM.setFileInputFiles', {
        objectId,
        files: [filePath],
      });
      await chrome.debugger.sendCommand(debuggee, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        awaitPromise: false,
      });
      await chrome.debugger.sendCommand(debuggee, 'Runtime.releaseObjectGroup', {
        objectGroup: 'aio-upload',
      }).catch(() => undefined);
    });
    await reportTab(await chrome.tabs.get(tabId));
    return { uploaded: true, selector };
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

async function withDebugger(tabId, callback) {
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand) {
    throw new Error('Chrome debugger API is unavailable for file uploads.');
  }
  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, '1.3');
  try {
    return await callback(debuggee);
  } finally {
    await chrome.debugger.detach(debuggee).catch(() => undefined);
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
    element.textContent = value;
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
  if (typeof tabId !== 'number') {
    return;
  }
  await Promise.all([
    markControlledTabGroup(tabId),
    installControlGlow(tabId),
  ]);
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

  // Reuse the single canonical "AI Orchestrator" control group in this tab's
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

async function installControlGlow(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: installControlGlowScript,
  }).catch(() => undefined);
}

async function removeControlGlow(tabId) {
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

  function applyType(element, value) {
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    if (element.isContentEditable) {
      element.textContent = value;
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

function sendNativeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}
