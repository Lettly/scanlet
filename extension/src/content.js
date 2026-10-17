/*
 * Scanlet bridge — the content script.
 *
 * A web page cannot call `chrome.runtime` directly, so this script is the
 * bridge between the two worlds: it relays window messages out to the service
 * worker and the worker's answers back in. It makes no decisions of its own.
 */

const FROM_PAGE = 'scanlet-page';
const TO_PAGE = 'scanlet-extension';
const VERSION = chrome.runtime.getManifest().version;

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.source !== FROM_PAGE) return;

  if (data.type === 'ping') {
    window.postMessage(
      { source: TO_PAGE, type: 'pong', requestId: data.requestId, version: VERSION },
      location.origin,
    );
    return;
  }

  const request = { ...data };
  delete request.source;
  try {
    chrome.runtime.sendMessage(request);
  } catch {
    // The extension was reloaded or removed; tell the page so it can fall back.
    window.postMessage(
      {
        source: TO_PAGE,
        requestId: data.requestId,
        type: 'error',
        error: 'The Scanlet extension is not available.',
      },
      location.origin,
    );
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== TO_PAGE) return;
  window.postMessage(message, location.origin);
});
