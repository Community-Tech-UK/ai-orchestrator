const HOST_NAME = 'com.ai_orchestrator.browser_gateway';
const INVENTORY_ALARM = 'browser-gateway-inventory';
const POLL_TIMEOUT_MS = 10000;
const POLL_IDLE_DELAY_MS = 250;
const POLL_ERROR_DELAY_MS = 5000;
const MAX_INVENTORY_TABS = 40;

let nativePort = null;
let pollInFlight = false;
let inventoryInFlight = false;

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

function connectNativePort() {
  if (nativePort) {
    return nativePort;
  }
  nativePort = chrome.runtime.connectNative(HOST_NAME);
  nativePort.onMessage.addListener((message) => {
    void handleNativeMessage(message);
  });
  nativePort.onDisconnect.addListener(() => {
    nativePort = null;
    pollInFlight = false;
    setTimeout(() => {
      void startBridge().catch(() => undefined);
    }, POLL_ERROR_DELAY_MS);
  });
  return nativePort;
}

function postNativeMessage(message) {
  try {
    connectNativePort().postMessage(message);
  } catch {
    nativePort = null;
    pollInFlight = false;
    setTimeout(() => {
      void startBridge().catch(() => undefined);
    }, POLL_ERROR_DELAY_MS);
  }
}

async function handleNativeMessage(message) {
  if (!message || message.type !== 'browser_command') {
    return;
  }
  pollInFlight = false;
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

async function executeBrowserCommand(command) {
  switch (command.command) {
    case 'open_tab': {
      const url = requirePayloadString(command, 'url');
      const tab = await chrome.tabs.create({ url, active: true });
      await waitForTabComplete(tab.id);
      return buildTabPayload(await chrome.tabs.get(tab.id), {
        includeText: true,
        includeScreenshot: true,
      });
    }
    case 'navigate': {
      const tabId = requireTargetTabId(command);
      const url = requirePayloadString(command, 'url');
      const tab = await chrome.tabs.update(tabId, { url, active: true });
      await waitForTabComplete(tabId);
      return buildTabPayload(tab || await chrome.tabs.get(tabId), {
        includeText: true,
        includeScreenshot: true,
      });
    }
    case 'click':
      return runInTargetTab(command, clickElementScript, [
        requirePayloadString(command, 'selector'),
      ]);
    case 'type':
      return runInTargetTab(command, typeElementScript, [
        requirePayloadString(command, 'selector'),
        requirePayloadString(command, 'value'),
      ]);
    case 'fill_form':
      return runInTargetTab(command, fillFormScript, [
        Array.isArray(command.payload?.fields) ? command.payload.fields : [],
      ]);
    case 'select':
      return runInTargetTab(command, selectElementScript, [
        requirePayloadString(command, 'selector'),
        requirePayloadString(command, 'value'),
      ]);
    case 'snapshot': {
      const tab = await chrome.tabs.get(requireTargetTabId(command));
      return buildTabPayload(tab, { includeText: true });
    }
    case 'screenshot': {
      const tab = await chrome.tabs.get(requireTargetTabId(command));
      await focusTab(tab);
      return {
        screenshotBase64: await captureScreenshot(tab.windowId),
        capturedAt: Date.now(),
      };
    }
    case 'wait_for':
      return runInTargetTab(command, waitForElementScript, [
        typeof command.payload?.selector === 'string' ? command.payload.selector : 'body',
        typeof command.payload?.timeoutMs === 'number' ? command.payload.timeoutMs : 30000,
      ]);
    default:
      throw new Error(`Unsupported browser command: ${command.command}`);
  }
}

async function runInTargetTab(command, func, args) {
  const tabId = requireTargetTabId(command);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  await reportTab(await chrome.tabs.get(tabId));
  return result?.result ?? null;
}

async function buildTabPayload(tab, options = {}) {
  if (!isWebTab(tab)) {
    throw new Error('Chrome tab is not an http(s) page.');
  }
  const page = options.includeText
    ? await capturePageText(tab.id).catch(() => ({ title: tab.title, text: '' }))
    : { title: tab.title, text: '' };
  const screenshotBase64 = options.includeScreenshot
    ? await captureScreenshot(tab.windowId).catch(() => undefined)
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
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 120000),
    }),
  });
  return result?.result || { title: '', text: '' };
}

async function captureScreenshot(windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  return dataUrl.replace(/^data:image\/png;base64,/i, '');
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

async function focusTab(tab) {
  if (typeof tab.windowId === 'number') {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  }
  if (typeof tab.id === 'number') {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
  }
}

function clickElementScript(selector) {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`No element matches selector: ${selector}`);
  }
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.click();
  return describeElement(element);
}

function typeElementScript(selector, value) {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`No element matches selector: ${selector}`);
  }
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus();
  if (element.isContentEditable) {
    element.textContent = value;
  } else {
    element.value = value;
  }
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return describeElement(element);
}

function fillFormScript(fields) {
  return fields.map((field) => {
    if (!field || typeof field.selector !== 'string') {
      throw new Error('Invalid form field selector.');
    }
    return typeElementScript(field.selector, String(field.value ?? ''));
  });
}

function selectElementScript(selector, value) {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`No element matches selector: ${selector}`);
  }
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus();
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return describeElement(element);
}

function waitForElementScript(selector, timeoutMs) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(describeElement(existing));
      return;
    }
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timed out waiting for selector: ${selector}`));
    }, timeoutMs);
    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (!element) {
        return;
      }
      clearTimeout(timeout);
      observer.disconnect();
      resolve(describeElement(element));
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

function describeElement(element) {
  return {
    tagName: element.tagName,
    text: (element.innerText || element.textContent || '').slice(0, 1000),
    value: typeof element.value === 'string' ? element.value.slice(0, 1000) : undefined,
  };
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
