// Private state machine. Dependencies are supplied only by the extension's
// fixed adapter, never by command payloads. A verified code remains private
// only until the one submit, cancellation, disconnect or bounded expiry.
function createCodexDeviceHandoff(deps) {
  const operations = new Map();
  const retired = new Map();
  const keys = ['operationHandle', 'approvalId', 'expectedIdentity', 'expiresAt',
    'extensionInstanceId', 'extensionGeneration', 'documentId'];
  const completion = () => ({ completed: true,
    observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin' });
  const refused = () => new Error('codex_device_handoff_refused');
  const invalidateTab = (tabId) => {
    const op = operations.get(tabId);
    if (op) {
      retired.set(op.binding.operationHandle, op.binding.expiresAt);
      op.code = undefined;
      clearTimeout(op.timer);
    }
    operations.delete(tabId);
  };
  const valid = (binding) => {
    try {
      const runtime = deps.runtime();
      return binding && keys.every((key) => key === 'expiresAt'
        ? Number.isSafeInteger(binding[key]) && binding[key] > deps.now()
          && binding[key] <= deps.now() + 300000
        : typeof binding[key] === 'string' && binding[key].length > 0 && binding[key].length <= 256)
        && binding.extensionInstanceId === runtime.extensionInstanceId
        && binding.extensionGeneration === runtime.extensionGeneration
        && deps.enabled() === true;
    } catch { return false; }
  };
  const route = (url, device) => {
    try {
      return new URL(url).origin === 'https://auth.openai.com'
        && (device ? deps.isDevice(url) : deps.isConsent(url));
    } catch { return false; }
  };
  const current = (op) => operations.get(op.tabId) === op && valid(op.binding);
  const check = (op) => { if (!current(op)) throw refused(); };
  const readFrame = async (op, device) => {
    check(op);
    const frame = await deps.getFrame(op.tabId);
    check(op);
    if (!frame || frame.documentId !== op.binding.documentId
      || !route(frame.url, device)) throw refused();
  };
  const owned = (tabId, binding, phase, documentId) => {
    const op = operations.get(tabId);
    if (!op || !valid(binding) || op.phase !== phase
      || keys.some((key) => op.binding[key] !== binding[key])
      || (documentId !== undefined && documentId !== op.binding.documentId)) {
      invalidateTab(tabId);
      throw refused();
    }
    return op;
  };
  const guarded = async (op, work) => {
    try { return await work(); } catch {
      invalidateTab(op.tabId);
      // Chrome and page errors can include their private arguments.
      throw refused();
    }
  };
  return {
    invalidateTab,
    invalidateAll: () => { for (const tabId of operations.keys()) invalidateTab(tabId); },
    navigation(kind, event) {
      if (event.frameId !== 0) return;
      const op = operations.get(event.tabId);
      if (!op) return;
      // The observed consent route uses exactly one same-document history
      // transition. Every full navigation, reload and other history event is
      // refused, including a second transition to the same callback path.
      if (current(op) && op.phase === 'transitioning' && kind === 'history'
        && event.documentId === op.binding.documentId && route(event.url, true)) {
        op.phase = 'transitioned';
      } else invalidateTab(event.tabId);
    },
    async attest(tabId, binding) {
      for (const [oldTabId, op] of operations) if (!valid(op.binding)) invalidateTab(oldTabId);
      for (const [handle, expiry] of retired) if (expiry <= deps.now()) retired.delete(handle);
      if (!Number.isInteger(tabId) || tabId < 0 || !valid(binding)
        || retired.has(binding.operationHandle)
        || operations.has(tabId)
        || [...operations.values()].some((op) => op.binding.operationHandle === binding.operationHandle)) {
        invalidateTab(tabId);
        throw refused();
      }
      if (operations.size + retired.size >= 64) throw refused();
      const op = { tabId, binding: { ...binding }, phase: 'attesting' };
      operations.set(tabId, op);
      op.timer = setTimeout(() => {
        if (operations.get(tabId) === op) invalidateTab(tabId);
      }, binding.expiresAt - deps.now());
      op.timer?.unref?.();
      return guarded(op, () => deps.withBoundary(async () => {
        await readFrame(op, false);
        const consent = await deps.consent(tabId, op.binding.documentId);
        check(op);
        if (consent?.identity !== binding.expectedIdentity) throw refused();
        // Consent itself produces a sensitive callback query. Quarantine its
        // origin before clicking, not just when the native code is filled.
        await deps.taint(tabId);
        await readFrame(op, false);
        op.phase = 'transitioning';
        // The adapter rechecks the identity immediately before the owned click.
        await deps.transition(tabId, op.binding.documentId, op.binding.expectedIdentity, () => current(op));
        check(op);
        if (op.phase !== 'transitioned') throw refused();
        await readFrame(op, true);
        op.phase = 'ready';
        return { completed: true, deviceDocumentId: op.binding.documentId };
      }));
    },
    async fill(tabId, binding, documentId, code) {
      const op = owned(tabId, binding, 'ready', documentId);
      op.phase = 'filling';
      return guarded(op, () => deps.withBoundary(async () => {
        await readFrame(op, true);
        await deps.taint(tabId);
        await readFrame(op, true);
        if (typeof code !== 'string' || !/^[A-Za-z0-9]{9}$/.test(code)) throw refused();
        if (await deps.fill(tabId, documentId, code, binding.expiresAt, () => current(op)) !== true) throw refused();
        await readFrame(op, true);
        op.code = code;
        op.phase = 'filled';
        return completion();
      }));
    },
    async submit(tabId, binding, documentId) {
      const op = owned(tabId, binding, 'filled', documentId);
      op.phase = 'submitting';
      return guarded(op, () => deps.withBoundary(async () => {
        await readFrame(op, true);
        // Atomically spend the right to dispatch. The adapter's private
        // isCurrent closure permits only this call while it is in flight.
        if (await deps.submit(tabId, documentId, op.code, binding.expiresAt, () => current(op)) !== true) throw refused();
        invalidateTab(tabId);
        return completion();
      }));
    },
    cancel(tabId, binding) {
      const op = operations.get(tabId);
      if (!op || keys.some((key) => op.binding[key] !== binding?.[key])) throw refused();
      invalidateTab(tabId);
      return { completed: true };
    },
  };
}

// Serialized only into the exact Chrome documentId by the trusted adapter.
// This function never returns a code, aggregate, URL or page exception.
async function codexDevicePage(action, expectedIdentity, code, expiresAt) {
  try {
    const origin = 'https://auth.openai.com';
    const consentPath = '/sign-in-with-chatgpt/codex/consent';
    const devicePath = '/deviceauth/callback';
    const active = () => location.origin === origin && Number.isSafeInteger(expiresAt)
      && Date.now() < expiresAt;
    if (!active()) return false;
    const visible = (element) => {
      if (!element?.isConnected || element.closest('[hidden]')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && rect.width > 0 && rect.height > 0;
    };
    const forms = [...document.querySelectorAll('form')].filter((form) => {
      const url = new URL(form.action, location.href);
      return form.method.toLowerCase() === 'post' && url.origin === origin
        && url.pathname === (location.pathname === consentPath ? consentPath : '/deviceauth/authorize_code');
    });
    if (forms.length !== 1) return false;
    const form = forms[0];
    const formUnchanged = () => {
      const url = new URL(form.action, location.href);
      return form.isConnected && form.method.toLowerCase() === 'post' && url.origin === origin
        && url.pathname === '/deviceauth/authorize_code';
    };
    if (action === 'consent' || action === 'transition') {
      if (location.pathname !== consentPath
        || form.getAttribute('aria-label') !== 'Sign in to Codex with ChatGPT') return false;
      const identities = [...form.querySelectorAll('span')].filter((span) => span.children.length === 0
        && visible(span) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(span.textContent.trim()));
      if (identities.length !== 1) return false;
      const identity = identities[0].textContent.trim();
      if (action === 'consent') return { identity };
      if (identity !== expectedIdentity) return false;
      const buttons = [...form.querySelectorAll('button')].filter((button) => button.type === 'submit'
        && visible(button) && button.textContent.trim() === 'Continue' && !button.disabled);
      if (buttons.length !== 1 || !active()) return false;
      buttons[0].click();
      return true;
    }
    if (!['fill', 'submit'].includes(action) || location.pathname !== devicePath
      || typeof code !== 'string' || !/^[A-Za-z0-9]{9}$/.test(code)) return false;
    const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const inputs = [];
    for (let i = 1; i <= 9; i++) {
      const matches = form.querySelectorAll(`input[name="character_${i}"]`);
      if (matches.length !== 1) return false;
      const input = matches[0];
      if (!(input instanceof HTMLInputElement) || input.type !== 'text' || input.maxLength !== 1
        || input.inputMode !== 'text' || input.autocomplete !== 'one-time-code'
        || input.getAttribute('aria-label') !== `Code character ${i} of 9`
        || !visible(input) || input.disabled || input.readOnly) return false;
      inputs.push(input);
    }
    if ([...form.querySelectorAll('input')].filter((input) => input.type !== 'hidden').length !== 9) return false;
    const aggregates = ['user_code', 'user_code_text'].map((name) => form.querySelectorAll(`input[name="${name}"]`));
    if (aggregates.some((fields) => fields.length !== 1 || fields[0].type !== 'hidden' || fields[0].disabled)) return false;
    const complete = () => active() && location.pathname === devicePath && formUnchanged()
      && inputs.every((input, index) => input.isConnected && input.form === form
        && input.name === `character_${index + 1}` && !input.disabled && !input.readOnly
        && form.querySelectorAll(`input[name="character_${index + 1}"]`).length === 1
        && value.get.call(input) === code[index])
      && aggregates.every((fields, index) => fields[0].isConnected && fields[0].form === form
        && fields[0].name === ['user_code', 'user_code_text'][index] && !fields[0].disabled
        && value.get.call(fields[0]) === code);
    if (action === 'fill') {
      for (let i = 0; i < inputs.length; i++) {
        if (!active() || location.pathname !== devicePath || !formUnchanged() || !inputs[i].isConnected) return false;
        value.set.call(inputs[i], code[i]);
        inputs[i].dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: code[i] }));
        inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
      }
      await Promise.resolve();
      return complete();
    }
    const buttons = [...form.querySelectorAll('button')].filter((button) => button.type === 'submit'
      && button.name === 'decision' && button.value === 'grant' && visible(button)
      && button.textContent.trim() === 'Continue' && !button.disabled
      && !['formaction', 'formmethod', 'formtarget'].some((name) => button.hasAttribute(name)));
    if (buttons.length !== 1 || !complete()) return false;
    buttons[0].click();
    return true;
  } catch {
    return false;
  }
}

// This adapter is internal to the authenticated native command dispatcher.
// It must never be exposed as a caller-supplied-code browser tool.
function createCodexDeviceExtensionAdapter(deps) {
  const chrome = deps.chrome;
  const epochs = new Map();
  const running = new Map();
  const owners = new Map();
  const transitions = new Map();
  const refused = () => new Error('codex_device_handoff_refused');
  const isRoute = (url, path) => {
    try { const parsed = new URL(url); return parsed.origin === 'https://auth.openai.com' && parsed.pathname === path; }
    catch { return false; }
  };
  const isConsent = (url) => isRoute(url, '/sign-in-with-chatgpt/codex/consent');
  const isDevice = (url) => isRoute(url, '/deviceauth/callback');
  const getFrame = async (tabId) => {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    if (!frame || frame.documentLifecycle !== 'active' || typeof frame.documentId !== 'string'
      || !frame.documentId || frame.documentId.length > 256) throw refused();
    return frame;
  };
  const inject = async (tabId, documentId, action, identity, code, expiry, current) => {
    const execution = running.get(tabId);
    const until = Math.min(execution?.deadlineAt ?? 0, expiry);
    if (!execution || Date.now() >= until || deps.enabled() !== true || !current()) throw refused();
    const results = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, world: 'ISOLATED',
      func: codexDevicePage, args: [action, identity, code, until],
    });
    if (results?.length !== 1 || results[0].frameId !== 0 || results[0].documentId !== documentId) throw refused();
    return results[0].result;
  };
  const core = createCodexDeviceHandoff({
    now: () => Date.now(), runtime: deps.runtime, enabled: deps.enabled,
    isConsent, isDevice, getFrame, withBoundary: deps.withBoundary,
    taint: (tabId) => deps.taint(tabId, 'https://auth.openai.com'),
    consent: (tabId, documentId) => inject(tabId, documentId, 'consent', '', '',
      running.get(tabId)?.deadlineAt ?? 0, () => true),
    transition: async (tabId, documentId, identity, current) => {
      let resolveTransition;
      const wait = new Promise((resolve) => { resolveTransition = resolve; });
      const timer = setTimeout(() => resolveTransition(false),
        Math.max(0, (running.get(tabId)?.deadlineAt ?? 0) - Date.now()));
      transitions.set(tabId, resolveTransition);
      try {
        if (await inject(tabId, documentId, 'transition', identity, '',
          running.get(tabId)?.deadlineAt ?? 0, current) !== true || !await wait || !current()) throw refused();
      } finally {
        clearTimeout(timer);
        transitions.delete(tabId);
      }
    },
    fill: (tabId, documentId, code, expiry, current) => inject(tabId, documentId, 'fill', '', code, expiry, current),
    submit: (tabId, documentId, code, expiry, current) => inject(tabId, documentId, 'submit', '', code, expiry, current),
  });
  const invalidateTab = (tabId) => {
    if (running.has(tabId)) epochs.set(tabId, (epochs.get(tabId) ?? 0) + 1);
    owners.delete(tabId);
    core.invalidateTab(tabId);
    transitions.get(tabId)?.(false);
  };
  const navigation = (kind, event) => {
    if (event.frameId !== 0) return;
    if (running.has(event.tabId)) epochs.set(event.tabId, (epochs.get(event.tabId) ?? 0) + 1);
    core.navigation(kind, event);
    transitions.get(event.tabId)?.(kind === 'history' && event.documentLifecycle === 'active' && isDevice(event.url));
  };
  chrome.webNavigation.onBeforeNavigate.addListener((event) => navigation('before', event));
  chrome.webNavigation.onCommitted.addListener((event) => navigation('committed', event));
  chrome.webNavigation.onHistoryStateUpdated.addListener((event) => navigation('history', event));
  chrome.webNavigation.onReferenceFragmentUpdated.addListener((event) => navigation('fragment', event));
  chrome.webNavigation.onErrorOccurred.addListener((event) => navigation('error', event));
  chrome.webNavigation.onTabReplaced.addListener((event) => {
    invalidateTab(event.tabId); invalidateTab(event.replacedTabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => { invalidateTab(tabId); epochs.delete(tabId); });
  const invalidateAll = () => {
    core.invalidateAll();
    owners.clear();
    for (const tabId of running.keys()) invalidateTab(tabId);
  };
  // A different tab can switch the account without navigating our document.
  // Inspect only the cookie domain, never its name/value. Even a normal auth
  // cookie refresh refuses this operation until the live flow proves otherwise.
  chrome.cookies.onChanged.addListener((change) => {
    const domain = change?.cookie?.domain;
    if (typeof domain === 'string' && /(^|\.)openai\.com$/i.test(domain)) invalidateAll();
  });
  return {
    invalidateTab,
    invalidateAll,
    async run(command, deadlineAt, owner) {
      const tabId = command?.target?.tabId;
      let execution;
      try {
        const runtime = deps.runtime();
        if (!owner || typeof owner !== 'object' || !Number.isInteger(tabId) || tabId < 0 || deps.enabled() !== true
          || !Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt
          || !/^[A-Za-z0-9_-]{8,64}$/.test(runtime.extensionInstanceId)
          || !/^\d+$/.test(runtime.extensionGeneration)
          || command.target.extensionInstanceId !== runtime.extensionInstanceId) throw refused();
        const payload = command.payload;
        if (command.command !== 'codex_device_context') {
          if (command.command === 'codex_device_attest' && !owners.has(tabId)) owners.set(tabId, owner);
          if (owners.get(tabId) !== owner) { invalidateTab(tabId); throw refused(); }
        }
        if (command.command === 'codex_device_cancel') {
          const result = core.cancel(tabId, payload?.binding);
          owners.delete(tabId);
          return result;
        }
        if (running.has(tabId)) { invalidateTab(tabId); throw refused(); }
        execution = { deadlineAt };
        running.set(tabId, execution);
        if (command.command === 'codex_device_context') {
          return await deps.withBoundary(async () => {
            const epoch = epochs.get(tabId) ?? 0;
            const frame = await getFrame(tabId);
            if (!isConsent(frame.url) || typeof payload?.expectedIdentity !== 'string'
              || !payload.expectedIdentity || payload.expectedIdentity.length > 256) throw refused();
            const result = await inject(tabId, frame.documentId, 'consent', '', '', deadlineAt, () => (epochs.get(tabId) ?? 0) === epoch);
            const after = await getFrame(tabId);
            const nowRuntime = deps.runtime();
            if (result?.identity !== payload.expectedIdentity || frame.documentId !== after.documentId
              || !isConsent(after.url) || (epochs.get(tabId) ?? 0) !== epoch
              || nowRuntime.extensionInstanceId !== runtime.extensionInstanceId
              || nowRuntime.extensionGeneration !== runtime.extensionGeneration
              || deps.enabled() !== true || Date.now() >= deadlineAt) throw refused();
            return { documentId: frame.documentId, extensionInstanceId: runtime.extensionInstanceId,
              extensionGeneration: runtime.extensionGeneration, identityMatches: true };
          });
        }
        if (command.command === 'codex_device_attest') return await core.attest(tabId, payload?.binding);
        if (command.command === 'codex_device_fill') return await core.fill(tabId, payload?.binding, payload?.deviceDocumentId, payload?.code);
        if (command.command === 'codex_device_submit') {
          const result = await core.submit(tabId, payload?.binding, payload?.deviceDocumentId);
          owners.delete(tabId);
          return result;
        }
        throw refused();
      } catch {
        invalidateTab(tabId);
        throw refused();
      } finally {
        if (execution && running.get(tabId) === execution) { running.delete(tabId); epochs.delete(tabId); }
      }
    },
  };
}
