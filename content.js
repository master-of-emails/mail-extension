/* content.js — reports address + (on view page) extracts codes/CTAs from DOM. */
(() => {
  if (window.top !== window) return;

  const SOCIAL_HOSTS = [
    'twitter.com', 'youtube.com', 'youtu.be',
    'facebook.com', 'fb.com', 'tiktok.com', 'x.com'
  ];
  const TEXT_RE = /\b(verify|confirm|activate|2fa|two[\s-]?factor|sign\s*in|log\s*in|reset|unlock|authorize|approve|accept|enable|click\s*here)\b/i;
  const URL_RE  = /\/(verify|confirm|activation|activate|authorize|signin|sign-in|login|log-in|reset|unlock|approve|accept|enable|validation|account_verifications|verifyEmail)\b/i;
  const KW_RE   = /\b(code|otp|pin|verification|verify|passcode|one[\s-]?time|security\s*code|2fa|two[\s-]?factor)\b/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isSocialHost(host) {
    return SOCIAL_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  }

  function extractCodes(text) {
    const out = [];
    const seen = new Set();
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

  async function pollAddress() {
    for (let i = 0; i < 120; i++) {
      const el = document.querySelector('#mail');
      const v = el && typeof el.value === 'string' ? el.value.trim() : '';
      if (v && v !== 'Loading') return v;
      await sleep(500);
    }
    return null;
  }

  async function reportAddress() {
    try {
      const v = await pollAddress();
      if (v) browser.runtime.sendMessage({ type: 'address', value: v }).catch(() => {});
    } catch { /* ignore */ }
  }

  function collectListIds() {
    const listEl = document.querySelector('.inbox-area.maillist');
    if (!listEl) return [];
    const seen = new Set();
    const out = [];
    for (const a of listEl.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href');
      if (!raw) continue;
      let abs;
      try { abs = new URL(raw, location.href).href; } catch { continue; }
      const m = abs.match(/\/view\/([A-Za-z0-9]+)/);
      if (!m) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ id: m[1], url: abs });
    }
    return out;
  }

  async function reportList() {
    const items = collectListIds();
    if (items.length) {
      browser.runtime.sendMessage({ type: 'listItems', items }).catch(() => {});
    }
  }

  function collectViewItem() {
    const container = document.querySelector('.inbox-area.onemail');
    if (!container) return null;

    const urlId = (location.pathname.match(/\/view\/([A-Za-z0-9]+)/) || [])[1];
    const id = container.getAttribute('data-id') || urlId;
    if (!id) return null;

    const subjEl =
      document.querySelector('.user-data-subject h4') ||
      document.querySelector('.inbox-area.onemail h4');
    const subject = subjEl ? subjEl.textContent.trim() : '';

    const fromEl = document.querySelector('.from-email');
    const from = fromEl ? fromEl.textContent.trim() : '';

    const bodyText = container.textContent || '';
    const { ctas, allLinks } = extractLinks(container, location.href);
    const codes = extractCodes(bodyText);

    return {
      id,
      subject: subject.slice(0, 300),
      from,
      codes,
      ctas,
      allLinks,
      viewUrl: location.href,
      ts: Date.now()
    };
  }

  function reportView() {
    const item = collectViewItem();
    if (item) {
      browser.runtime.sendMessage({ type: 'viewItem', item }).catch(() => {});
    }
  }

  async function runScan() {
    if (document.querySelector('.inbox-area.maillist')) {
      await reportList();
    } else if (document.querySelector('.inbox-area.onemail')) {
      reportView();
    }
    await reportAddress();
  }

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === 'changeAddress') {
      (async () => {
        try {
          const btn = document.querySelector('#click-to-delete');
          if (btn) btn.click();
          try {
            await browser.storage.local.remove([
              'mailItems', 'lastMail', 'lastMailAt', 'lastUrl', 'history', 'address'
            ]);
          } catch { /* ignore */ }
          await sleep(1500);
          await reportAddress();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }

    if (msg.type === 'rescan') {
      runScan().catch(() => {}).finally(() => sendResponse({ ok: true }));
      return true;
    }

    return false;
  });

  let started = false;
  function start() {
    if (started) return;
    started = true;
    reportAddress().catch(() => {});
    runScan().catch(() => {});
    setInterval(() => { runScan().catch(() => {}); }, 30000);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(start, 200);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(start, 200), { once: true });
  }
})();
