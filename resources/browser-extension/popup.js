const shareButton = document.getElementById('share');
const reconnectButton = document.getElementById('reconnect');
const reloadButton = document.getElementById('reload');
const status = document.getElementById('status');
const gateways = document.getElementById('gateways');
const sharedTabs = document.getElementById('shared-tabs');
const shareDisclosure = document.getElementById('share-disclosure');
const version = document.getElementById('version');
const gatewayEnabledToggle = document.getElementById('gateway-enabled');
const gatewayEnabledState = document.getElementById('gateway-enabled-state');

const GATEWAY_LABELS = {
  local: 'Harness app',
  relay: 'Worker relay',
};

const isDevExtension = !chrome.runtime.getManifest().update_url;
if (isDevExtension) {
  reloadButton.classList.add('visible');
}

gatewayEnabledToggle.addEventListener('change', async () => {
  const enabled = gatewayEnabledToggle.checked === true;
  gatewayEnabledToggle.disabled = true;
  status.textContent = enabled ? 'Turning Browser Gateway on...' : 'Turning Browser Gateway off...';
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'set_gateway_enabled',
      enabled,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Browser Gateway state was not changed.');
    }
    renderStatus(response);
    status.textContent = enabled
      ? 'Browser Gateway is on.'
      : 'Browser Gateway is off for login.';
  } catch (error) {
    gatewayEnabledToggle.checked = !enabled;
    status.textContent = error instanceof Error ? error.message : String(error);
    await refreshStatus().catch(() => undefined);
  } finally {
    gatewayEnabledToggle.disabled = false;
  }
});

shareButton.addEventListener('click', async () => {
  shareButton.disabled = true;
  status.textContent = 'Sharing tab...';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'share_active_tab' });
    if (!response?.ok) {
      throw new Error(response?.error || response?.response?.error || 'Tab was not shared.');
    }
    const recipients = formatRecipients(response.recipients ?? []);
    status.textContent = recipients ? `Tab shared with ${recipients}.` : 'Tab shared.';
    await refreshStatus();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    shareButton.disabled = false;
  }
});

reconnectButton.addEventListener('click', async () => {
  reconnectButton.disabled = true;
  status.textContent = 'Reconnecting gateways...';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'reconnect_bridges' });
    if (!response?.ok) {
      throw new Error(response?.error || 'Reconnect failed.');
    }
    renderStatus(response);
    status.textContent = 'Reconnect requested.';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    reconnectButton.disabled = false;
  }
});

reloadButton.addEventListener('click', () => {
  status.textContent = 'Reloading extension...';
  chrome.runtime.reload();
});

void refreshStatus().catch((error) => {
  status.textContent = error instanceof Error ? error.message : String(error);
});

async function refreshStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'getStatus' });
  if (!response?.ok) {
    throw new Error(response?.error || 'Status is unavailable.');
  }
  renderStatus(response);
}

function renderStatus(response) {
  version.textContent = response.extensionVersion ? `v${response.extensionVersion}` : '';
  const gatewayEnabled = response.gatewayEnabled !== false;
  renderGatewayToggle(gatewayEnabled);
  renderGateways(Array.isArray(response.bridges) ? response.bridges : [], gatewayEnabled);
  renderSharedTabs(Array.isArray(response.sharedTabs) ? response.sharedTabs : []);
}

function renderGatewayToggle(gatewayEnabled) {
  gatewayEnabledToggle.checked = gatewayEnabled;
  gatewayEnabledState.textContent = gatewayEnabled ? 'On' : 'Off for login';
  shareButton.disabled = !gatewayEnabled;
  reconnectButton.disabled = !gatewayEnabled;
}

function renderGateways(bridges, gatewayEnabled) {
  gateways.replaceChildren();
  if (!gatewayEnabled) {
    for (const bridge of bridges) {
      gateways.appendChild(gatewayRow(bridge));
    }
    if (bridges.length === 0) {
      gateways.appendChild(emptyRow('Browser Gateway is off.'));
    }
    shareDisclosure.textContent = 'Browser Gateway is off. Turn it on after login to share tabs.';
    return;
  }
  if (bridges.length === 0) {
    gateways.appendChild(emptyRow('No gateways reported yet.'));
    shareDisclosure.textContent = 'No gateway is connected for sharing.';
    return;
  }

  for (const bridge of bridges) {
    gateways.appendChild(gatewayRow(bridge));
  }
  const connected = bridges.filter((bridge) => bridge.state === 'connected');
  const recipients = formatRecipients(connected);
  shareDisclosure.textContent = recipients
    ? `Share sends this tab to ${recipients}.`
    : 'No gateway is connected for sharing.';
}

function gatewayRow(bridge) {
  const row = document.createElement('div');
  row.className = 'gateway-row';
  row.dataset.gatewayKind = bridge.kind;

  const main = document.createElement('div');
  main.className = 'gateway-main';

  const signal = document.createElement('span');
  signal.className = `signal ${signalClass(bridge.state)}`;

  const name = document.createElement('div');
  name.className = 'gateway-name';
  name.textContent = GATEWAY_LABELS[bridge.kind] ?? bridge.hostName;

  main.append(signal, name);

  const detail = document.createElement('div');
  detail.className = 'gateway-detail';
  detail.textContent = bridgeDetail(bridge);

  row.append(main, detail);
  return row;
}

function bridgeDetail(bridge) {
  const bits = [stateLabel(bridge)];
  if (bridge.lastPollAckAt) {
    bits.push(`last contact ${formatAge(bridge.lastPollAckAt)}`);
  }
  if (bridge.silentPollCount > 0) {
    bits.push(`${bridge.silentPollCount} silent poll${bridge.silentPollCount === 1 ? '' : 's'}`);
  }
  if (bridge.lastError) {
    bits.push(bridge.lastError);
  }
  return bits.join(' - ');
}

function stateLabel(bridge) {
  if (bridge.state === 'disabled') {
    return 'off';
  }
  if (bridge.state === 'reconnecting') {
    return `reconnecting (${bridge.reconnectAttempts ?? 0})`;
  }
  return bridge.state ?? 'unknown';
}

function signalClass(state) {
  if (state === 'connected') {
    return 'ok';
  }
  if (state === 'reconnecting') {
    return 'warn';
  }
  if (state === 'disabled') {
    return '';
  }
  return 'bad';
}

function renderSharedTabs(tabs) {
  sharedTabs.replaceChildren();
  if (tabs.length === 0) {
    sharedTabs.appendChild(emptyRow('No tabs shared from this popup yet.'));
    return;
  }
  for (const tab of tabs) {
    const row = document.createElement('div');
    row.className = 'tab-row';

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url || `Tab ${tab.tabId}`;

    const detail = document.createElement('div');
    detail.className = 'tab-url';
    const recipients = formatRecipients(tab.recipients ?? []);
    detail.textContent = [
      tab.url,
      tab.sharedAt ? `shared ${formatAge(tab.sharedAt)}` : '',
      recipients ? `to ${recipients}` : '',
    ].filter(Boolean).join(' - ');

    row.append(title, detail);
    sharedTabs.appendChild(row);
  }
}

function emptyRow(text) {
  const row = document.createElement('div');
  row.className = 'empty';
  row.textContent = text;
  return row;
}

function formatRecipients(recipients) {
  const labels = recipients
    .map((recipient) => GATEWAY_LABELS[recipient.kind] ?? recipient.hostName)
    .filter(Boolean);
  if (labels.length === 0) {
    return '';
  }
  if (labels.length === 1) {
    return labels[0];
  }
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function formatAge(timestamp) {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 2) {
    return 'just now';
  }
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} s ago`;
  }
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  return `${elapsedMinutes} min ago`;
}
