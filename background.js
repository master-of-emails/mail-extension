// background.js — event page for Inbox Mail Grabber
//
// Responsibilities:
//   1. Receive captured mail from the content script.
//   2. Persist current + history + source URL to storage.local.
//   3. Optionally forward to an HTTP endpoint.
//
// Notes:
//   - Background event pages get suspended in Firefox MV3, so we keep NO
//     long-lived state here. Everything durable lives in storage.local.
//   - The poller lives in content.js, not here, for the same reason.

const ENDPOINT = null;           // e.g. 'http://localhost:5000/inbox' — null disables
const MAX_HISTORY = 50;          // cap on stored entries

console.log('[inbox-grabber] background loaded');

// --- message handler -------------------------------------------------------

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'mail') return;

  // Do async work without blocking the message channel
  handleMail(msg, sender).catch((e) =>
    console.error('[inbox-grabber] handleMail failed:', e)
  );
});

async function handleMail(msg, sender) {
  const value = msg.value;
  const at    = msg.at || Date.now();
  const url   = msg.url || sender?.tab?.url || '';

  console.log('[inbox-grabber] got mail:', value);

  // --- 1. load existing state ---------------------------------------------
  const state = await browser.storage.local.get([
    'lastMail', 'lastMailAt', 'lastUrl', 'history',
  ]);

  const history = Array.isArray(state.history) ? state.history.slice() : [];

  // --- 2. de-dupe: only record if it's a new value ------------------------
  const isNew = history.length === 0 || history[0].value !== value;

  if (isNew) {
    history.unshift({ value, at, url });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  }

  // --- 3. persist ---------------------------------------------------------
  await browser.storage.local.set({
    lastMail:   value,
    lastMailAt: at,
    lastUrl:    url,
    history,
  });

  // --- 4. optional forwarding --------------------------------------------
  if (ENDPOINT) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, at, url }),
      });
      console.log('[inbox-grabber] forwarded →', ENDPOINT, res.status);
    } catch (e) {
      console.warn('[inbox-grabber] forward failed:', e);
    }
  }
}

// --- startup banner (helpful when debugging via about:debugging) ----------

browser.runtime.onStartup.addListener(() => {
  console.log('[inbox-grabber] background started (browser startup)');
});

browser.runtime.onInstalled.addListener((details) => {
  console.log('[inbox-grabber] installed/updated:', details.reason);
});
