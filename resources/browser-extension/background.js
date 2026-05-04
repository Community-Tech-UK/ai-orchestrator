const HOST_NAME = 'com.ai_orchestrator.browser_gateway';
const POLL_INTERVAL_MS = 1500;
const sharedTargets = new Map();
const pollTimers = new Map();

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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || typeof tab.windowId !== 'number') {
    return;
  }
  const key = targetKey(tab.windowId, tabId);
  if (!sharedTargets.has(key)) {
    return;
  }
  shareTabById(tabId).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  const key = targetKey(removeInfo.windowId, tabId);
  sharedTargets.delete(key);
  const timer = pollTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    pollTimers.delete(key);
  }
});

async function shareActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || typeof tab.windowId !== 'number' || !tab.url) {
    throw new Error('No active Chrome tab is available to share.');
  }

  return shareTab(tab);
}

async function shareTabById(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id || typeof tab.windowId !== 'number' || !tab.url) {
    throw new Error('Chrome tab is no longer available.');
  }
  return shareTab(tab);
}

async function shareTab(tab) {
  const page = await capturePageText(tab.id).catch(() => ({
    title: tab.title,
    text: '',
  }));
  const screenshotBase64 = await captureScreenshot(tab.windowId).catch(() => undefined);
  const response = await sendNativeMessage({
    type: 'attach_tab',
    tab: {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: page.title || tab.title,
      text: page.text || '',
      screenshotBase64,
      capturedAt: Date.now(),
    },
  });
  rememberSharedTarget(tab, response);

  return {
    ok: Boolean(response?.ok),
    response,
  };
}

function rememberSharedTarget(tab, response) {
  const target = response?.result?.data;
  if (!target?.profileId || !target?.id) {
    return;
  }
  const key = targetKey(tab.windowId, tab.id);
  sharedTargets.set(key, {
    profileId: target.profileId,
    targetId: target.id,
    tabId: tab.id,
    windowId: tab.windowId,
  });
  schedulePoll(key);
}

function schedulePoll(key) {
  if (pollTimers.has(key)) {
    return;
  }
  const timer = setTimeout(() => {
    pollTimers.delete(key);
    pollSharedTarget(key).catch(() => undefined);
  }, POLL_INTERVAL_MS);
  pollTimers.set(key, timer);
}

async function pollSharedTarget(key) {
  const target = sharedTargets.get(key);
  if (!target) {
    return;
  }
  try {
    const response = await sendNativeMessage({
      type: 'poll_commands',
      tab: target,
    });
    const command = response?.result;
    if (command?.kind === 'refresh_tab' && command?.id) {
      await completeRefreshCommand(target, command.id);
    }
  } finally {
    if (sharedTargets.has(key)) {
      schedulePoll(key);
    }
  }
}

async function completeRefreshCommand(target, commandId) {
  try {
    const tab = await chrome.tabs.get(target.tabId);
    if (!tab?.url) {
      throw new Error('Chrome tab is no longer available.');
    }
    const page = await capturePageText(target.tabId).catch(() => ({
      title: tab.title,
      text: '',
    }));
    const screenshotBase64 = await captureScreenshot(target.windowId).catch(() => undefined);
    await sendNativeMessage({
      type: 'complete_command',
      commandId,
      status: 'succeeded',
      tab: {
        ...target,
        url: tab.url,
        title: page.title || tab.title,
        text: page.text || '',
        screenshotBase64,
        capturedAt: Date.now(),
      },
    });
  } catch (error) {
    await sendNativeMessage({
      type: 'complete_command',
      commandId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      tab: target,
    });
  }
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

function targetKey(windowId, tabId) {
  return `${windowId}:${tabId}`;
}
