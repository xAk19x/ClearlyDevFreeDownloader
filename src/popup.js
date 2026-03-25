const addFreeBtn = document.getElementById('add-free-btn');
const downloadAllBtn = document.getElementById('download-all-btn');
const statusNode = document.getElementById('status');

function setBusy(isBusy) {
  addFreeBtn.disabled = isBusy;
  downloadAllBtn.disabled = isBusy;
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.style.color = isError ? '#fda4af' : '#bae6fd';
}

async function sendAction(action) {
  setBusy(true);
  setStatus('Working...');

  try {
    const response = await chrome.runtime.sendMessage({ action });

    if (!response?.ok) {
      setStatus(response?.error || 'Action failed.', true);
      return;
    }

    setStatus(response.message || 'Done.');
  } catch (error) {
    setStatus(error.message || 'Unexpected extension error.', true);
  } finally {
    setBusy(false);
  }
}

addFreeBtn.addEventListener('click', () => {
  void sendAction('addFreeProductsToCart');
});

downloadAllBtn.addEventListener('click', () => {
  void sendAction('downloadAllLibraryAssets');
});
