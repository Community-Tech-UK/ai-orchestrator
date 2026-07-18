/**
 * Exact browser program served by the remote observer. Keeping it as a static
 * asset lets the document use a strict same-origin CSP without inline code.
 */
export const OBSERVER_CLIENT_SCRIPT = `(() => {
  'use strict';

  const token = new URLSearchParams(window.location.search).get('token') || '';
  const authSuffix = token ? '?token=' + encodeURIComponent(token) : '';
  const safePillClasses = new Set([
    'running',
    'failed',
    'error',
    'waiting_for_input',
    'busy',
    'running-job',
  ]);
  const state = {
    snapshot: null,
    selectedInstanceId: '',
    messageCache: new Map(),
  };

  const els = {
    stats: document.getElementById('stats'),
    instanceList: document.getElementById('instance-list'),
    jobList: document.getElementById('job-list'),
    detailList: document.getElementById('detail-list'),
    messageList: document.getElementById('message-list'),
    detailTitle: document.getElementById('detail-title'),
    instanceCount: document.getElementById('instance-count'),
    jobCount: document.getElementById('job-count'),
    instanceSelect: document.getElementById('instance-select'),
    refreshBtn: document.getElementById('refresh-btn'),
    openReplayBtn: document.getElementById('open-replay-btn'),
    observerUrls: document.getElementById('observer-urls'),
  };

  function text(value, fallback = '') {
    return value === undefined || value === null || value === ''
      ? fallback
      : String(value);
  }

  function node(tagName, className, content) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = text(content);
    return element;
  }

  function emptyMessage(content) {
    return node('p', 'empty', content);
  }

  function formatDate(value) {
    if (!value) return 'n/a';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return text(value);
    }
  }

  function pill(label, requestedClass = '') {
    const element = node('span', 'pill', label);
    if (safePillClasses.has(requestedClass)) {
      element.classList.add(requestedClass);
    }
    return element;
  }

  function row(left, right) {
    const element = node('div', 'row');
    element.append(left, right);
    return element;
  }

  function safeObserverUrl(value) {
    try {
      const parsed = new URL(text(value));
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  function renderStats(snapshot) {
    const status = snapshot.status || {};
    const stats = [
      ['Mode', status.mode],
      ['Instances', status.instanceCount],
      ['Jobs', status.jobCount],
      ['Prompts', status.pendingPromptCount],
      ['Last Event', formatDate(status.lastEventAt)],
    ].map(([label, value]) => {
      const article = node('article', 'stat');
      article.append(node('span', 'meta', label), node('strong', '', value));
      return article;
    });
    els.stats.replaceChildren(...stats);

    const links = (status.observerUrls || []).flatMap((value) => {
      const parsed = safeObserverUrl(value);
      if (!parsed) return [];
      const link = node('a', '', value);
      link.href = parsed.href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      return [link];
    });
    els.observerUrls.replaceChildren(...links);
  }

  function renderInstances(snapshot) {
    const instances = snapshot.instances || [];
    els.instanceCount.textContent = String(instances.length);

    const placeholder = node('option', '', 'Select instance');
    placeholder.value = '';
    const options = instances.map((instance) => {
      const option = node(
        'option',
        '',
        text(instance.displayName) + ' (' + text(instance.status) + ')',
      );
      option.value = text(instance.id);
      option.selected = option.value === state.selectedInstanceId;
      return option;
    });
    els.instanceSelect.replaceChildren(placeholder, ...options);

    if (instances.length === 0) {
      els.instanceList.replaceChildren(emptyMessage('No instances are running.'));
      return;
    }

    const cards = instances.map((instance) => {
      const card = node('div', 'card');
      const status = text(instance.status);
      const heading = node('h3', '', instance.displayName);
      card.append(
        row(heading, pill(status, status)),
        node(
          'p',
          'meta',
          text(instance.provider, 'provider n/a') + ' · ' + text(instance.model, 'model n/a'),
        ),
        node('p', 'meta', instance.workingDirectoryLabel),
        node('p', 'meta', 'Last activity ' + formatDate(instance.lastActivity)),
      );
      const inspectButton = node('button', '', 'Inspect');
      inspectButton.type = 'button';
      inspectButton.dataset.instanceId = text(instance.id);
      card.append(inspectButton);
      return card;
    });
    els.instanceList.replaceChildren(...cards);
  }

  function renderJobs(snapshot) {
    const jobs = snapshot.jobs || [];
    els.jobCount.textContent = String(jobs.length);
    if (jobs.length === 0) {
      els.jobList.replaceChildren(emptyMessage('No repo jobs have been recorded.'));
      return;
    }

    const cards = jobs.map((job) => {
      const card = node('div', 'card');
      const status = text(job.status);
      const statusClass = status === 'running' ? 'running-job' : status;
      card.append(
        row(node('h3', '', job.name), pill(status, statusClass)),
        node('p', 'meta', text(job.type) + ' · ' + text(job.workingDirectory)),
        node(
          'p',
          'meta',
          text(job.progressMessage, 'Progress ' + text(job.progress, '0') + '%'),
        ),
      );
      if (job.result && job.result.summary) {
        card.append(node('pre', '', job.result.summary));
      }
      return card;
    });
    els.jobList.replaceChildren(...cards);
  }

  function detailCard(label, value) {
    const card = node('div', 'detail-card');
    card.append(node('h3', '', label), node('p', 'meta', value));
    return card;
  }

  async function loadMessages(instanceId) {
    if (!instanceId) {
      els.detailTitle.textContent = 'Select an instance';
      els.detailList.replaceChildren();
      els.messageList.replaceChildren(emptyMessage('Messages will appear here.'));
      return;
    }

    const response = await fetch(
      '/api/instances/' + encodeURIComponent(instanceId) + '/messages' + authSuffix,
    );
    if (!response.ok) {
      els.messageList.replaceChildren(emptyMessage('Failed to load messages.'));
      return;
    }
    const messages = await response.json();
    state.messageCache.set(instanceId, Array.isArray(messages) ? messages : []);
    renderDetails(instanceId);
  }

  function renderDetails(instanceId) {
    const snapshot = state.snapshot;
    if (!snapshot || !instanceId) return;

    const instance = (snapshot.instances || []).find(
      (item) => text(item.id) === text(instanceId),
    );
    els.detailTitle.textContent = instance ? text(instance.displayName) : text(instanceId);
    if (instance) {
      els.detailList.replaceChildren(
        detailCard('Status', instance.status),
        detailCard('Provider', text(instance.provider, 'n/a')),
        detailCard('Model', text(instance.model, 'n/a')),
        detailCard('Workspace', instance.workingDirectoryLabel),
      );
    } else {
      els.detailList.replaceChildren(emptyMessage('Instance not found.'));
    }

    const prompts = (snapshot.pendingPrompts || [])
      .filter((prompt) => text(prompt.instanceId) === text(instanceId));
    const promptCards = prompts.map((prompt) => {
      const card = node('div', 'detail-card');
      const promptClass = prompt.promptType === 'input-required' ? 'waiting_for_input' : '';
      card.append(
        row(node('h3', '', prompt.title), pill(prompt.promptType, promptClass)),
        node('p', 'meta', prompt.message),
      );
      return card;
    });

    const messages = state.messageCache.get(instanceId) || [];
    const messageCards = messages.length === 0
      ? [emptyMessage('No messages loaded for this instance.')]
      : messages.slice(-120).map((message) => {
          const article = node('article', 'message');
          article.append(
            row(
              node('span', '', message.type),
              node('span', 'meta', formatDate(message.timestamp)),
            ),
            node('pre', '', text(message.content)),
          );
          return article;
        });
    els.messageList.replaceChildren(...promptCards, ...messageCards);
  }

  function showFatalError() {
    const message = node(
      'main',
      'observer-error',
      'Observer authentication failed or the server is unavailable.',
    );
    document.body.replaceChildren(message);
  }

  async function loadSnapshot() {
    const response = await fetch('/api/snapshot' + authSuffix);
    if (!response.ok) {
      showFatalError();
      return false;
    }

    state.snapshot = await response.json();
    if (
      !state.selectedInstanceId
      && state.snapshot.instances
      && state.snapshot.instances[0]
    ) {
      state.selectedInstanceId = text(state.snapshot.instances[0].id);
    }
    render();
    await loadMessages(state.selectedInstanceId);
    return true;
  }

  function render() {
    if (!state.snapshot) return;
    renderStats(state.snapshot);
    renderInstances(state.snapshot);
    renderJobs(state.snapshot);
    renderDetails(state.selectedInstanceId);
  }

  function connectEvents() {
    const source = new EventSource('/api/events' + authSuffix);
    source.onmessage = () => {};
    ['status', 'repo-job', 'instance-state', 'instance-output', 'permission-prompt']
      .forEach((type) => {
        source.addEventListener(type, async () => {
          await loadSnapshot();
        });
      });
    source.addEventListener('error', () => {
      window.setTimeout(connectEvents, 2000);
      source.close();
    });
  }

  els.instanceSelect.addEventListener('change', async () => {
    state.selectedInstanceId = els.instanceSelect.value;
    renderDetails(state.selectedInstanceId);
    await loadMessages(state.selectedInstanceId);
  });

  els.refreshBtn.addEventListener('click', async () => {
    await loadSnapshot();
  });

  els.openReplayBtn.addEventListener('click', () => {
    if (!state.selectedInstanceId) return;
    window.open(
      '/api/instances/' + encodeURIComponent(state.selectedInstanceId) + '/replay' + authSuffix,
      '_blank',
      'noopener,noreferrer',
    );
  });

  document.addEventListener('click', async (event) => {
    const target = event.target instanceof Element
      ? event.target.closest('[data-instance-id]')
      : null;
    if (!target) return;
    state.selectedInstanceId = target.getAttribute('data-instance-id') || '';
    els.instanceSelect.value = state.selectedInstanceId;
    await loadMessages(state.selectedInstanceId);
  });

  loadSnapshot()
    .then((loaded) => {
      if (loaded) connectEvents();
    })
    .catch(showFatalError);
})();`;
