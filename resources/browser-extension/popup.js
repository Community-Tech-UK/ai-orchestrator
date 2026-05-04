const shareButton = document.getElementById('share');
const status = document.getElementById('status');

shareButton.addEventListener('click', async () => {
  shareButton.disabled = true;
  status.textContent = 'Sharing tab...';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'share_active_tab' });
    if (!response?.ok) {
      throw new Error(response?.error || response?.response?.error || 'Tab was not shared.');
    }
    status.textContent = 'Tab shared with AI Orchestrator.';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    shareButton.disabled = false;
  }
});
