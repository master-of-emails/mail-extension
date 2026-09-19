// content.js — runs inside the inbox page.
//
// Job: poll #mail.value (the property, NOT the data-value attribute, which
// stays "Loading" forever), extract the email with a regex, and forward it
// to background.js whenever it changes.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const POLL_MS  = 500;

let last  = null;
let timer = null;

function poll() {
  const el = document.querySelector('#mail');
  if (!el) return;

  const v = el.value;
  if (!v || v === 'Loading' || v === last) return;

  last = v;
  const m = v.match(EMAIL_RE);
  const mail = m ? m[0] : v;

  console.log('[inbox-grabber] captured:', mail);

  browser.runtime.sendMessage({
    type:  'mail',
    value: mail,
    raw:   v,
    at:    Date.now(),
    url:   location.href,
  }).catch(() => { /* background asleep or no listener — fine */ });
}

function start() {
  if (timer) return;
  poll();
  timer = setInterval(poll, POLL_MS);
}

function boot() {
  if (document.querySelector('#mail')) {
    start();
    return;
  }
  // #mail may be injected after us — wait for it to appear
  const obs = new MutationObserver(() => {
    if (document.querySelector('#mail')) {
      obs.disconnect();
      start();
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
