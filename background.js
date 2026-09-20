/* background.js — background fetch, tab-cycling fallback, hidden tab, merge. */

const TARGET_URL = 'https://temp-mail.org/en/';
const KEEPALIVE_MS = 30000;
const TARGET_MATCHES = ['*://temp-mail.org/*', '*://*.temp-mail.org/*'];
const MAX_FETCH_PER_SCAN = 12;
const MAX_TAB_VISITS_PER_SCAN = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let hiddenTabId = null;
let tabVisitRunning = false;

console.log('[myinbox-monitor] background v1.1.0 loaded');

/* ---------- extractors ---------- */

const SOCIAL_HOSTS = [
  'twitter.com', 'youtube.com', 'youtu.be',
  'facebook.com', 'fb.com', 'tiktok.com', 'x.com'
];
const TEXT_RE = /\b(verify|confirm|activate|2fa|two[\s-]?factor|sign\s*in|log\s*in|reset|unlock|authorize|approve|accept|enable|click\s*here)\b/i;
const URL_RE  = /\/(verify|confirm|activation|activate|authorize|signin|sign-in|login|log-in|reset|unlock|approve|accept|enable|validation|account_verifications|verifyEmail)\b/i;
const KW_RE   = /\b(code|otp|pin|verification|verify|passcode|one[\s-]?time|security\s*code|2fa|two[\s-]?factor)\b/i;

function isSocialHost(host) {
  return SOCIAL_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

function extractCodes(text) {
  const out = []; const seen = new Set();
  if (!text) return out;

  const digitRe = /\b\d{4,8}\b/g;
  let m;
  while ((m = digitRe.exec(text))) {
    const val = m[0];
    if (/^(19|20)\d{2}$/.test(val)) continue;
    const s = Math.max(0, m.index - 120);
    const e = Math.min(text.length, m.index + val.length + 120);
    if (KW_RE.test(text.slice(s, e)) && !seen.has(val)) {
      seen.add(val); out.push(val);
      if (out.length >= 5) return out;
    }
  }
  const alnumRe = /\b[A-Z0-9]{6,8}\b/g;
  while ((m = alnumRe.exec(text))) {
    const val = m[0];
    if (/^\d+$/.test(val)) continue;
    const s = Math.max(0, m.index - 120);
    const e = Math.min(text.length, m.index + val.length + 120);
    if (KW_RE.test(text.slice(s, e)) && !seen.has(val)) {
      seen.add(val); out.push(val);
      if (out.length >= 5) return out;
    }
  }
  return out;
}

function extractLinks(container, baseUrl) {
  const ctas = [], allLinks = [];
  const seenC = new Set(), seenA = new Set();
  if (!container) return { ctas, allLinks };

  container.querySelectorAll('a[href]').forEach((a) => {
    const raw = a.getAttribute('href');
    if (!raw) return;
    if (raw.startsWith('javascript:') || raw.startsWith('mailto:')) return;
    let abs;
    try { abs = new URL(raw, baseUrl).href; } catch { return; }
    if (!/^https?:/i.test(abs)) return;

    let host;
    try { host = new URL(abs).hostname; } catch { return; }
    if (isSocialHost(host)) return;

    const text = (a.textContent || '').trim();

    if (!seenA.has(abs)) {
      seenA.add(abs);
      allLinks.push({ href: abs, text: text.slice(0, 300) });
    }

    const urlMatch = URL_RE.test(abs);
    const textMatch = TEXT_RE.test(text);
    if ((urlMatch || textMatch) && !seenC.has(abs)) {
      seenC.add(abs);
      ctas.push({ href: abs, text: text.slice(0, 200), label: text || abs });
    }
  });

  return { ctas, allLinks };
}

/* ---------- background fetch of view page ---------- */

async function fetchAndParseView(id, url) {
  let r;
  try {
    r = await fetch(url, { credentials: 'include', redirect: 'follow' });
  } catch (e) {
    console.log('[myinbox-monitor] fetch failed for', id, String(e));
    return null;
  }
  if (!r.ok) {
    console.log('[myinbox-monitor] fetch status', r.status, 'for', id);
    return null;
  }

  const html = await r.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const container = doc.querySelector('.inbox-area.onemail');
  if (!container) {
    console.log('[myinbox-monitor] no .inbox-area.onemail in fetched', id, 'len', html.length);
    return null;
  }

  const dataId = container.getAttribute('data-id') || id;
  const subjEl =
    doc.querySelector('.user-data-subject h4') ||
    doc.querySelector('.inbox-area.onemail h4');
  const subject = subjEl ? subjEl.textContent.trim() : '';
  const fromEl = doc.querySelector('.from-email');
  const from = fromEl ? fromEl.textContent.trim() : '';
  const bodyText = container.textContent || '';
  const { ctas, allLinks } = extractLinks(container, url);
  const codes = extractCodes(bodyText);

  return {
    id: dataId, subject: subject.slice(0, 300), from,
    codes, ctas, allLinks, viewUrl: url, ts: Date.now()
  };
}

/* ---------- merge ---------- */

function mergeByHref(a = [], b = []) {
  const map = new Map();
  for (const x of a) if (x && x.href) map.set(x.href, x);
  for (const x of b) {
    if (!x || !x.href) continue;
    const prev = map.get(x.href);
    if (!prev) map.set(x.href, x);
    else {
      const merged = { ...prev, ...x };
      if ((prev.text || '').length > (x.text || '').length) merged.text = prev.text;
      if ((prev.label || '').length > (x.label || '').length) merged.label = prev.label;
      map.set(x.href, merged);
    }
  }
  return Array.from(map.values());
}

function mergeByValue(a = [], b = []) {
  const out = []; const seen = new Set();
  for (const v of [...a, ...b]) {
    if (typeof v !== 'string' || seen.has(v)) continue;
    seen.add(v); out.push(v);
    if (out.length >= 5) break;
  }
  return out;
}

function mergeItem(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a, ...b };
  out.ctas = mergeByHref(a.ctas || [], b.ctas || []);
  out.codes = mergeByValue(a.codes || [], b.codes || []);
  out.allLinks = mergeByHref(a.allLinks || [], b.allLinks || []);
  if ((a.subject || '').length > (b.subject || '').length) out.subject = a.subject;
  if ((a.from || '').length > (b.from || '').length) out.from = a.from;
  if ((a.viewUrl || '').length > (b.viewUrl || '').length) out.viewUrl = a.viewUrl;
  out.ts = Math.max(a.ts || 0, b.ts || 0) || Date.now();
  return out;
}

/* ---------- storage ---------- */

async function handleItem(item) {
  if (!item || !item.id) return;

  const store = await browser.storage.local.get(['mailItems', 'history']);
  let items = Array.isArray(store.mailItems) ? store.mailItems : [];

  const idx = items.findIndex((x) => x && x.id === item.id);
  if (idx >= 0) items[idx] = mergeItem(items[idx], item);
  else items.push(item);

  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  items = items.slice(0, 50);

  let history = Array.isArray(store.history) ? store.history : [];
  const hEntry = {
    id: item.id, subject: item.subject || '',
    viewUrl: item.viewUrl || '', ts: item.ts || Date.now(),
    codes: (item.codes || []).length, ctas: (item.ctas || []).length
  };
  const hIdx = history.findIndex((x) => x && x.id === item.id);
  if (hIdx >= 0) history[hIdx] = { ...history[hIdx], ...hEntry };
  else history.unshift(hEntry);
  history = history.slice(0, 50);

  await browser.storage.local.set({
    mailItems: items, history,
    lastMail: item.id, lastMailAt: item.ts || Date.now(),
    lastUrl: item.viewUrl || null
  });
}

/* ---------- tabs ---------- */

async function hideTab(tabId) {
  try { await browser.tabs.hide(tabId); }
  catch (e) { console.log('[myinbox-monitor] tabs.hide failed:', String(e)); }
}

async function waitForLoaded(tabId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await browser.tabs.get(tabId);
      if (t && t.status === 'complete' && typeof t.url === 'string'
          && t.url.includes('temp-mail.org') && !t.url.startsWith('about:')) {
        await sleep(300);
        return true;
      }
    } catch { /* ignore */ }
    await sleep(500);
  }
  return false;
}

async function waitForViewUrl(tabId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await browser.tabs.get(tabId);
      if (t && t.status === 'complete' && typeof t.url === 'string'
          && /\/view\//.test(t.url)) {
        return true;
      }
    } catch { /* ignore */ }
    await sleep(300);
  }
  return false;
}

async function findVisibleTab() {
  try {
    const tabs = await browser.tabs.query({ url: TARGET_MATCHES });
    return tabs.find((t) => t.id != null && t.id !== hiddenTabId) || null;
  } catch { return null; }
}

async function ensureInboxTab() {
  if (hiddenTabId != null) {
    try {
      const t = await browser.tabs.get(hiddenTabId);
      if (t && t.id != null) {
        await hideTab(t.id);
        await waitForLoaded(t.id);
        return t.id;
      }
    } catch { hiddenTabId = null; }
  }

  const visible = await findVisibleTab();
  if (visible && visible.id != null) {
    await waitForLoaded(visible.id);
    return visible.id;
  }

  const t = await browser.tabs.create({ url: TARGET_URL, active: false });
  hiddenTabId = t.id;
  await hideTab(t.id);
  await waitForLoaded(t.id);
  return t.id;
}

async function sendToTab(tabId, msg, attempts = 8, gapMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try { return await browser.tabs.sendMessage(tabId, msg); }
    catch { await sleep(gapMs); }
  }
  return null;
}

/* ---------- tab-cycling fallback ---------- */

function waitForViewReport(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const handler = (msg, sender) => {
      if (done) return;
      if (msg && msg.type === 'viewItem' && sender.tab && sender.tab.id === tabId) {
        done = true;
        browser.runtime.onMessage.removeListener(handler);
        resolve(msg.item);
      }
    };
    browser.runtime.onMessage.addListener(handler);
    setTimeout(() => {
      if (!done) {
        done = true;
        browser.runtime.onMessage.removeListener(handler);
        resolve(null);
      }
    }, timeoutMs);
  });
}

async function visitViewInHiddenTab(url) {
  const tabId = await ensureInboxTab();
  const p = waitForViewReport(tabId, 12000);
  await browser.tabs.update(tabId, { url });
  await waitForViewUrl(tabId, 12000);
  const item = await p;
  // Navigate back to the inbox list.
  await browser.tabs.update(tabId, { url: TARGET_URL });
  await waitForLoaded(tabId);
  await hideTab(tabId);
  return item;
}

/* ---------- list processing ---------- */

async function processListItems(list) {
  if (!Array.isArray(list) || !list.length) return;

  const store = await browser.storage.local.get(['mailItems']);
  const existing = new Map(
    (Array.isArray(store.mailItems) ? store.mailItems : [])
      .map((x) => [x && x.id, x])
  );

  const needContent = [];
  for (const { id, url } of list) {
    const cur = existing.get(id);
    const hasContent = cur && (((cur.codes || []).length) || ((cur.ctas || []).length));
    if (!hasContent) needContent.push({ id, url });
  }

  // 1. Try background fetch first (fast, no navigation).
  const stillEmpty = [];
  let fetched = 0;
  for (const { id, url } of needContent) {
    if (fetched >= MAX_FETCH_PER_SCAN) break;
    fetched++;
    const item = await fetchAndParseView(id, url);
    if (item && (item.codes.length || item.ctas.length)) {
      await handleItem(item);
    } else if (item) {
      await handleItem(item); // store what we got (subject/from)
      stillEmpty.push({ id, url });
    } else {
      stillEmpty.push({ id, url });
    }
    await sleep(200);
  }

  // 2. Fallback: cycle the hidden tab for those still empty.
  if (stillEmpty.length && !tabVisitRunning) {
    tabVisitRunning = true;
    try {
      let visited = 0;
      for (const { url } of stillEmpty) {
        if (visited >= MAX_TAB_VISITS_PER_SCAN) break;
        visited++;
        const item = await visitViewInHiddenTab(url);
        if (item) await handleItem(item);
      }
    } finally {
      tabVisitRunning = false;
    }
  }
}

/* ---------- message routing ---------- */

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'listItems') {
    processListItems(msg.items)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'viewItem') {
    handleItem(msg.item)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'address') {
    browser.storage.local.set({ address: msg.value, addressAt: Date.now() })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'newAddress') {
    (async () => {
      try {
        const tabId = await ensureInboxTab();
        await sendToTab(tabId, { type: 'changeAddress' });
        await browser.storage.local.remove([
          'mailItems', 'lastMail', 'lastMailAt', 'lastUrl', 'history', 'address'
        ]);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'refresh') {
    (async () => {
      try {
        const tabId = await ensureInboxTab();
        await sendToTab(tabId, { type: 'rescan' });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  return false;
});

/* ---------- keepalive ---------- */

async function keepAlive() {
  try {
    const tabId = await ensureInboxTab();
    await sendToTab(tabId, { type: 'rescan' }, 3, 500);
  } catch { /* swallow */ }
}

browser.runtime.onInstalled.addListener(() => { keepAlive(); });
browser.runtime.onStartup.addListener(() => { keepAlive(); });

keepAlive();
setInterval(keepAlive, KEEPALIVE_MS);
