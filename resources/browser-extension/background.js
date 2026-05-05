const HOST_NAME = 'com.ai_orchestrator.browser_gateway';

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

async function shareActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || typeof tab.windowId !== 'number' || !tab.url) {
    throw new Error('No active Chrome tab is available to share.');
  }

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

  return {
    ok: Boolean(response?.ok),
    response,
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
