/* popup.js */

const $ = (sel) => document.querySelector(sel);

function relTime(ts) {
  if (!ts) return '';
  const d = Math.max(0, Date.now() - ts);
  const s = Math.floor(d / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const dd = Math.floor(h / 24);
  return dd + 'd ago';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ---- render ---- */

async function render() {
  const store = await browser.storage.local.get(['address', 'mailItems', 'history']);

  const addr = store.address || '';
  const addrEl = $('#addr');
  addrEl.textContent = addr || '—';
  addrEl.title = addr;

  const items = Array.isArray(store.mailItems) ? store.mailItems : [];
  const hist = Array.isArray(store.history) ? store.history : [];

  const msgs = $('#msgs');
  msgs.innerHTML = '';
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No messages yet.';
    msgs.appendChild(e);
  } else {
    for (const it of items) msgs.appendChild(renderCard(it));
  }

  const hEl = $('#hist');
  hEl.innerHTML = '';
  if (!hist.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Empty.';
    hEl.appendChild(e);
  } else {
    for (const h of hist) hEl.appendChild(renderHist(h));
  }
}

function renderCard(it) {
  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';

  const subj = document.createElement('div');
  subj.className = 'card-subject';
  subj.textContent = it.subject || '(no subject)';
  subj.title = it.subject || '';

  const time = document.createElement('div');
  time.className = 'card-time';
  time.textContent = relTime(it.ts);

  head.appendChild(subj);
  head.appendChild(time);
  card.appendChild(head);

  const ctasCount = (it.ctas || []).length;
  const codesCount = (it.codes || []).length;

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = `${ctasCount} CTA · ${codesCount} code${codesCount === 1 ? '' : 's'}`;
  card.appendChild(meta);

  if (codesCount) {
    const wrap = document.createElement('div');
    wrap.className = 'codes';
    for (const code of it.codes) {
      const row = document.createElement('div');
      row.className = 'code-row';

      const num = document.createElement('span');
      num.className = 'code';
      num.textContent = code;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', async () => {
        if (await copyText(code)) {
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1100);
        }
      });

      row.appendChild(num);
      row.appendChild(btn);
      wrap.appendChild(row);
    }
    card.appendChild(wrap);
  }

  if (ctasCount) {
    const wrap = document.createElement('div');
    wrap.className = 'ctas';
    for (const cta of it.ctas) {
      const w = document.createElement('div');
      w.className = 'cta';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cta-btn';
      btn.textContent = cta.label || cta.text || cta.href;
      btn.title = cta.href;
      btn.addEventListener('click', () => {
        window.open(cta.href, '_blank', 'noopener,noreferrer');
      });

      const url = document.createElement('div');
      url.className = 'cta-url';
      url.textContent = cta.href;
      url.title = 'Click to copy';
      url.addEventListener('click', async () => {
        if (await copyText(cta.href)) {
          const prev = url.textContent;
          url.textContent = 'Copied!';
          setTimeout(() => { url.textContent = prev; }, 900);
        }
      });

      w.appendChild(btn);
      w.appendChild(url);
      wrap.appendChild(w);
    }
    card.appendChild(wrap);
  }

  if (!ctasCount && !codesCount) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'no url found';
    card.appendChild(none);
  }

  if (it.viewUrl) {
    const open = document.createElement('a');
    open.className = 'open-link';
    open.href = '#';
    open.textContent = 'open in inbox ↗';
    open.addEventListener('click', (e) => {
      e.preventDefault();
      browser.tabs.create({ url: it.viewUrl, active: true });
    });
    card.appendChild(open);
  }

  return card;
}

function renderHist(h) {
  const row = document.createElement('div');
  row.className = 'hist-row';

  const s = document.createElement('div');
  s.className = 'hist-subject';
  s.textContent = h.subject || h.id;
  s.title = h.subject || '';

  const t = document.createElement('div');
  t.className = 'hist-time';
  t.textContent = relTime(h.ts);

  row.appendChild(s);
  row.appendChild(t);

  if (h.viewUrl) {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      browser.tabs.create({ url: h.viewUrl, active: true });
    });
  }
  return row;
}

/* ---- interactions ---- */

$('#copy').addEventListener('click', async () => {
  const addr = $('#addr').textContent;
  if (!addr || addr === '—') return;
  const btn = $('#copy');
  if (await copyText(addr)) {
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1100);
  }
});

$('#new').addEventListener('click', async () => {
  const btn = $('#new');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    await browser.runtime.sendMessage({ type: 'newAddress' });
  } catch { /* ignore */ }
  btn.disabled = false;
  btn.textContent = 'New';

  // Refresh a few times while the site generates the new address.
  setTimeout(render, 500);
  setTimeout(render, 2500);
  setTimeout(render, 6000);
});

/* ---- lifecycle ---- */

browser.storage.onChanged.addListener(() => { render(); });

// Ask background to nudge a fresh scan when the popup opens.
(async () => {
  try { await browser.runtime.sendMessage({ type: 'refresh' }); } catch { /* ignore */ }
  render();
})();

setInterval(render, 10000); // keep relative times fresh
