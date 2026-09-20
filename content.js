// content.js — handles both the list page and the /view/<id> page.

console.log('[inbox-grabber] CONTENT v5');

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const POLL_MS  = 500;

const VIEW_LINK_RE = new RegExp(
  `^${location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/en/view/[0-9A-Za-z]+`
);

const SOCIAL_HOSTS =
  /(^|\.)(twitter\.com|youtube\.com|youtu\.be|facebook\.com|fb\.com|tiktok\.com|x\.com)$/i;

const CTA_RE =
  /\b(verify|confirm|activate|2fa|two[\s-]?factor|sign\s*in|log\s*in|reset|unlock|authorize|approve|accept|enable|click\s*here)\b/i;

const CTA_URL_RE =
  /\/(verify|confirm|activation|activate|authorize|signin|sign-in|login|log-in|reset|unlock|approve|accept|enable|validation|account_verifications|verifyEmail)\b/i;

const CODE_KEYWORDS =
  /\b(code|otp|pin|verification|verify|passcode|one[\s-]?time|security\s*code|2fa|two[\s-]?factor)\b/i;
const CODE_PATTERNS = [/\b\d{4,8}\b/g, /\b[A-Z0-9]{6,8}\b/g];

// --- shared state ----------------------------------------------------------

const processed = new Set();
let   lastAddr  = null;
let   addrTimer = null;

// --- address poller --------------------------------------------------------

function pollAddress() {
  const el = document.querySelector('#mail');
  if (!el) return;
  const v = el.value;
  if (!v || v === 'Loading' || v === lastAddr) return;
  lastAddr = v;
  const m = v.match(EMAIL_RE);
  browser.runtime.sendMessage({
    type: 'mail', value: m ? m[0] : v, raw: v,
    at: Date.now(), url: location.href,
  }).catch(() => {});
}
function startPoller() {
  if (addrTimer) return;
  pollAddress();
  addrTimer = setInterval(pollAddress, POLL_MS);
}

// --- helpers ---------------------------------------------------------------

function isViewPage() {
  return /\/view\/[0-9A-Za-z]+/.test(location.pathname);
}

function idFromUrl(href) {
  const m = href.match(/\/view\/([0-9A-Za-z]+)/);
  return m ? m[1] : href;
}

// --- scanner ---------------------------------------------------------------

function collectViewLinks() {
  if (isViewPage()) scanCurrentViewPage();
  else              scanListPage();
}

function scanCurrentViewPage() {
  const container = document.querySelector('.inbox-area.onemail');
  if (!container) {
    console.log('[inbox-grabber] view page, no .inbox-area.onemail yet');
    return;
  }

  const id = container.getAttribute('data-id') || idFromUrl(location.href);
  const text = container.textContent || '';
  const sig  = `${id}:${text.length}:${text.slice(0, 80)}`;
  if (processed.has(sig)) return;
  processed.add(sig);

  const subject =
    document.querySelector('.mail-subject, .subject, h1')?.textContent?.trim() ||
    document.title || '';

  const { allLinks, ctas } = extractLinks(container, location.href);
  const codes = extractCodes(text);

  console.log(
    `[inbox-grabber] view ${id} | anchors=${container.querySelectorAll('a[href]').length}` +
    ` allLinks=${allLinks.length} ctas=${ctas.length} codes=${codes.length}`
  );
  if (allLinks.length) console.log('  links:', allLinks.map(l => l.href));
  if (ctas.length)     console.log('  ctas :', ctas.map(c => c.text + ' → ' + c.href));
  if (!ctas.length)    console.warn('[inbox-grabber] no url found on', location.href);

  browser.runtime.sendMessage({
    type: 'mailItem',
    id, viewUrl: location.href, subject,
    codes, ctas, allLinks,
    found: ctas.length > 0 || codes.length > 0,
    at: Date.now(),
  }).catch(() => {});
}

function scanListPage() {
  const list =
    document.querySelector('.inbox-area.maillist') ||
    document.querySelector('.inbox-area') ||
    document.body;

  const anchors = [...list.querySelectorAll('a[href]')];
  const matches = anchors.filter(a => VIEW_LINK_RE.test(a.href));

  console.log(
    `[inbox-grabber] list=${list.className || list.tagName} ` +
    `anchors=${anchors.length} viewMatches=${matches.length} ` +
    `alreadyProcessed=${processed.size}`
  );

  for (const a of matches) {
    const href = a.href.split('#')[0].split('?')[0];
    if (processed.has(href)) continue;
    processed.add(href);

    const subject =
      (a.querySelector('.subject, .title, .mail-subject')?.textContent ||
       a.textContent || '').trim().slice(0, 140);

    console.log('[inbox-grabber] new view link:', href, '| subj:', subject);
    processViewLink(href, subject).catch(e =>
      console.warn('[inbox-grabber] view link failed', href, e));
  }
}

// --- fetch a view page and parse ------------------------------------------

async function processViewLink(viewUrl, subject) {
  let html;
  try {
    const res = await fetch(viewUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.warn('[inbox-grabber] fetch failed', viewUrl, e);
    browser.runtime.sendMessage({
      type: 'mailItem',
      id: idFromUrl(viewUrl), viewUrl, subject,
      codes: [], ctas: [], allLinks: [],
      found: false, error: String(e), at: Date.now(),
    }).catch(() => {});
    return;
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const container = doc.querySelector('.inbox-area.onemail');

  console.log(
    '[inbox-grabber] parsed', viewUrl,
    '| onemail?', !!container,
    '| linksInContainer:', container ? container.querySelectorAll('a[href]').length : 0,
  );

  const id = container?.getAttribute('data-id') || idFromUrl(viewUrl);
  const { allLinks, ctas } = extractLinks(container, viewUrl);
  const codes = extractCodes(container?.textContent || '');

  console.log(
    '[inbox-grabber] extracted id=', id,
    'allLinks=', allLinks.length, 'ctas=', ctas.length, 'codes=', codes.length,
  );
  if (ctas.length)  console.log('  ctas :', ctas.map(c => c.text + ' → ' + c.href));
  if (!ctas.length) console.warn('[inbox-grabber] no url found on', viewUrl);

  browser.runtime.sendMessage({
    type: 'mailItem',
    id, viewUrl, subject,
    codes, ctas, allLinks,
    found: ctas.length > 0 || codes.length > 0,
    at: Date.now(),
  }).catch(() => {});
}

// --- extraction ------------------------------------------------------------

function extractLinks(container, baseUrl) {
  const allLinks = [];
  const ctas = [];
  const seen = new Set();

  if (!container) {
    console.log('[inbox-grabber] extractLinks: no container');
    return { allLinks, ctas };
  }

  const anchors = [...container.querySelectorAll('a[href]')];
  console.log(`[inbox-grabber] extractLinks: ${anchors.length} anchor(s) in container`);

  for (const a of anchors) {
    const raw  = a.getAttribute('href');
    const text = (a.textContent || '').trim().slice(0, 120);

    if (!raw) { console.log('[drop:no-href]'); continue; }

    let abs, host = '';
    try { abs = new URL(raw, baseUrl).href; }
    catch { console.log('[drop:bad-url]', raw); continue; }

    if (!/^https?:\/\//i.test(abs)) { console.log('[drop:protocol]', abs); continue; }

    try { host = new URL(abs).hostname; }
    catch { console.log('[drop:bad-host]', abs); continue; }

    if (SOCIAL_HOSTS.test(host)) {
      console.log('[drop:social]', host, '←', JSON.stringify(text));
      continue;
    }

    if (seen.has(abs)) { console.log('[drop:dup]', abs); continue; }
    seen.add(abs);

    const isCta = CTA_RE.test(text) || CTA_URL_RE.test(abs);
    console.log('[keep]', host, '| text:', JSON.stringify(text),
                '| cta?', isCta, '| href:', abs);

    allLinks.push({ href: abs, text: text || host, host });
    if (isCta) ctas.push({ href: abs, text: text || host, host });
  }

  return { allLinks, ctas };
}

function extractCodes(text) {
  const found = new Map();
  if (!text) return [];
  for (const re of CODE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const v = m[0];
      const start = Math.max(0, m.index - 120);
      const end   = Math.min(text.length, m.index + v.length + 120);
      const ctx   = text.slice(start, end);
      if (!CODE_KEYWORDS.test(ctx)) continue;
      if (/^\d{4}$/.test(v) && /^(19|20)\d{2}$/.test(v)) continue;
      if (!found.has(v)) found.set(v, { value: v, context: ctx.trim() });
    }
  }
  return [...found.values()].slice(0, 5);
}

// --- popup → content actions ----------------------------------------------

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'changeAddress') return;

  const btn = document.querySelector('#click-to-delete');
  if (!btn) {
    console.warn('[inbox-grabber] change button not found on page');
    return;
  }

  console.log('[inbox-grabber] clicking #click-to-delete');
  btn.click();

  lastAddr = null;
  processed.clear();

  browser.storage.local.remove([
    'mailItems', 'lastMail', 'lastMailAt', 'lastCodes', 'lastLinks',
  ]);
});

// --- boot ------------------------------------------------------------------

function boot() {
  if (document.querySelector('#mail')) startPoller();
  else {
    const obs = new MutationObserver(() => {
      if (document.querySelector('#mail')) { obs.disconnect(); startPoller(); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  let scanTimer = null;
  const scheduleScan = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(collectViewLinks, 400);
  };
  scheduleScan();
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true, subtree: true,
  });
  setInterval(collectViewLinks, 3000);

  console.log('[inbox-grabber] content loaded on', location.href);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
