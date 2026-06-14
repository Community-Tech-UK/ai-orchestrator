const shareButton = document.getElementById('share');
const reloadButton = document.getElementById('reload');
const status = document.getElementById('status');

const isDevExtension = !chrome.runtime.getManifest().update_url;
if (isDevExtension) {
  reloadButton.classList.add('visible');
}

shareButton.addEventListener('click', async () => {
  shareButton.disabled = true;
  status.textContent = 'Sharing tab...';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'share_active_tab' });
    if (!response?.ok) {
      throw new Error(response?.error || response?.response?.error || 'Tab was not shared.');
    }
    status.textContent = 'Tab shared with Harness.';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    shareButton.disabled = false;
  }
});

reloadButton.addEventListener('click', () => {
  status.textContent = 'Reloading extension...';
  chrome.runtime.reload();
});
