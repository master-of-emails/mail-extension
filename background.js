// background.js — event page. Keeps a hidden inbox tab alive so monitoring
// and the "New address" action work even when no visible tab is open.

const INBOX_URL   = 'https://temp-mail.org/en/';
const MAX_HISTORY = 50;

console.log('[inbox-grabber] background loaded');

let hiddenTabId = null;

// --- hidden tab management -------------------------------------------------

async function findInboxTab() {
  // prefer any visible tab the user already has open
  const tabs = await browser.tabs.query({ url: 'https://temp-mail.org/*' });
  return tabs[0] || null;
}

async function ensureInboxTab() {
  const existing = await findInboxTab();
  if (existing) return existing.id;

  if (hiddenTabId != null) {
    try {
      await browser.tabs.get(hiddenTabId);
      return hiddenTabId;
    } catch {
      hiddenTabId = null;
    }
  }

  const tab = await browser.tabs.create({ url: INBOX_URL, active: false });
  hiddenTabId = tab.id;
  console.log('[inbox-grabber] opened hidden inbox tab', tab.id);

  // wait for it to actually load before anyone tries to message it
  try {
    await waitForTabLoaded(tab.id);
    console.log('[inbox-grabber] hidden tab ready', tab.id);
  } catch (e) {
    console.warn('[inbox-grabber] hidden tab load timeout');
  }

  return tab.id;
}

// kick off monitoring at startup / install
browser.runtime.onStartup.addListener(() => {
  console.log('[inbox-grabber] started');
  ensureInboxTab().catch(console.error);
});
browser.runtime.onInstalled.addListener((d) => {
  console.log('[inbox-grabber] installed/updated:', d.reason);
  ensureInboxTab().catch(console.error);
});

// --- message router --------------------------------------------------------

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === 'mail')        handleMail(msg, sender).catch(console.error);
  if (msg.type === 'mailItem')    handleMailItem(msg, sender).catch(console.error);
  if (msg.type === 'newAddress')  handleNewAddress().catch(console.error);
  if (msg.type === 'ensureInbox') ensureInboxTab().catch(console.error);
});

// --- handlers --------------------------------------------------------------

async function handleMail(msg, sender) {
  const value = msg.value;
  const at    = msg.at || Date.now();
  const url   = msg.url || sender?.tab?.url || '';

  const state   = await browser.storage.local.get(['history']);
  const history = Array.isArray(state.history) ? state.history.slice() : [];
  if (history.length === 0 || history[0].value !== value) {
    history.unshift({ value, at, url });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  }

  await browser.storage.local.set({
    lastMail: value, lastMailAt: at, lastUrl: url, history,
  });
}

async function handleMailItem(msg, sender) {
  const state = await browser.storage.local.get(['mailItems']);
  const items = Array.isArray(state.mailItems) ? state.mailItems.slice() : [];

  const incoming = {
    id:      msg.id,
    viewUrl: msg.viewUrl,
    subject: msg.subject || '',
    codes:   msg.codes   || [],
    ctas:    msg.ctas    || [],
    allLinks:msg.allLinks|| [],
    found:   !!msg.found,
    error:   msg.error || null,
    at:      msg.at || Date.now(),
  };

  const idx = items.findIndex(i => i.id === incoming.id);

  if (idx < 0) {
    // brand new
    items.unshift(incoming);
  } else {
    const prev = items[idx];

    // merge ctas by href, merge codes by value — union of both reports
    const ctasByHref = new Map();
    for (const c of prev.ctas)     ctasByHref.set(c.href, c);
    for (const c of incoming.ctas) ctasByHref.set(c.href, c);

    const codesByValue = new Map();
    for (const c of prev.codes)     codesByValue.set(c.value, c);
    for (const c of incoming.codes) codesByValue.set(c.value, c);

    const allByHref = new Map();
    for (const l of prev.allLinks)     allByHref.set(l.href, l);
    for (const l of incoming.allLinks) allByHref.set(l.href, l);

    const merged = {
      ...prev,
      subject:  incoming.subject || prev.subject,
      viewUrl:  incoming.viewUrl || prev.viewUrl,
      codes:    [...codesByValue.values()],
      ctas:     [...ctasByHref.values()],
      allLinks: [...allByHref.values()],
      error:    incoming.error || prev.error,
      // keep newest timestamp only if the incoming report is actually newer
      at:       Math.max(prev.at || 0, incoming.at || 0),
    };
    merged.found = merged.ctas.length > 0 || merged.codes.length > 0;

    // only replace if the merge actually improved things
    const prevScore = prev.ctas.length + prev.codes.length;
    const newScore  = merged.ctas.length + merged.codes.length;

    if (newScore >= prevScore) {
      items[idx] = merged;
    } else {
      // incoming has less data — but if the previous report had an error, take
      // the incoming one to clear the error state
      if (prev.error && !incoming.error) items[idx] = { ...prev, error: null };
    }
  }

  if (items.length > MAX_HISTORY) items.length = MAX_HISTORY;

  const final = items.find(i => i.id === incoming.id);
  console.log('[inbox-grabber] mailItem', incoming.id,
              '| in:', incoming.ctas.length, 'ctas /', incoming.codes.length, 'codes',
              '| stored:', final?.ctas.length, 'ctas /', final?.codes.length, 'codes');

  await browser.storage.local.set({ mailItems: items });
}

// Wait until the tab has finished loading a URL that contains `urlPart`.
async function waitForTabLoaded(tabId, urlPart, timeoutMs = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    let t;
    try { t = await browser.tabs.get(tabId); }
    catch { throw new Error('tab was closed'); }

    const okUrl    = t.url && t.url.includes(urlPart);
    const okStatus = t.status === 'complete';

    if (okUrl && okStatus) return t;

    await new Promise(r => setTimeout(r, 250));
  }

  throw new Error('tab load timeout');
}

// try to send to a tab, and if the content script isn't ready, inject it
// (or just retry a couple times)
async function sendToTab(tabId, message, retries = 8, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      return await browser.tabs.sendMessage(tabId, message);
    } catch (e) {
      // "Receiving end does not exist" → content script not loaded yet
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function handleNewAddress() {
  const tabId = await ensureInboxTab();
  console.log('[inbox-grabber] asking tab', tabId, 'for new address');

  try {
    await waitForTabLoaded(tabId, 'temp-mail.org');
  } catch (e) {
    console.warn('[inbox-grabber] tab never finished loading:', e.message);
  }

  // give the content script's onMessage listener a beat to register
  await new Promise(r => setTimeout(r, 600));

  try {
    await sendToTab(tabId, { type: 'changeAddress' }, 8);
  } catch (e) {
    console.warn('[inbox-grabber] changeAddress failed:', e.message);
  }
}
