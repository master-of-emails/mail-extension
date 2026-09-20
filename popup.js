const $ = (id) => document.getElementById(id);
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

function fmtTime(ts) {
  if (!ts) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60)    return `${Math.floor(diff)}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 900);
    }
  } catch (e) { console.warn('copy failed', e); }
}

// --- render ----------------------------------------------------------------

function renderAddress(state) {
  const { lastMail, lastMailAt } = state;
  const cur = $('current-mail');
  cur.value = lastMail || '';
  cur.placeholder = lastMail ? '' : 'waiting for mail…';
  $('current-time').textContent = lastMail ? `captured ${fmtTime(lastMailAt)}` : '';

  const status = $('status');
  const fresh = lastMailAt && (Date.now() - lastMailAt) < 5 * 60 * 1000;
  status.textContent = lastMail ? (fresh ? 'live' : 'stale') : 'idle';
  status.className = 'status ' + (fresh ? 'on' : 'off');
}

function renderMailList(state) {
  const items = Array.isArray(state.mailItems) ? state.mailItems : [];
  const list  = $('mail-list');
  list.innerHTML = '';

  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No messages yet.';
    list.appendChild(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'mail-item ' + (item.found ? 'has-cta' : 'no-cta');

    const subj = document.createElement('div');
    subj.className = 'mail-subject';
    subj.textContent = item.subject || '(no subject)';
    subj.title = item.subject || '';
    li.appendChild(subj);

    const meta = document.createElement('div');
    meta.className = 'mail-meta';
    const bits = [fmtTime(item.at)];
    if (item.ctas.length)  bits.push(`${item.ctas.length} action${item.ctas.length > 1 ? 's' : ''}`);
    if (item.codes.length) bits.push(`${item.codes.length} code${item.codes.length > 1 ? 's' : ''}`);
    if (item.error)        bits.push('fetch failed');
    meta.textContent = bits.join(' · ');
    li.appendChild(meta);

    // codes
    for (const c of item.codes) {
      const row = document.createElement('div');
      row.className = 'code-row';

      const codeEl = document.createElement('span');
      codeEl.className = 'code';
      codeEl.textContent = c.value;

      const btn = document.createElement('button');
      btn.className = 'btn icon';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => copy(c.value, btn));

      row.append(codeEl, btn);
      li.appendChild(row);
    }

    // CTA buttons + raw URL
    if (item.ctas.length) {
      for (const cta of item.ctas) {
        const btn = document.createElement('button');
        btn.className = 'cta-btn';

        const label = document.createElement('span');
        label.textContent = cta.text || cta.host;

        const host = document.createElement('span');
        host.className = 'host';
        host.textContent = cta.host;

        btn.append(label, host);
        btn.title = cta.href;
        btn.addEventListener('click', () => {
          window.open(cta.href, '_blank', 'noopener,noreferrer');
        });
        li.appendChild(btn);

        const raw = document.createElement('div');
        raw.className = 'raw-url';
        raw.textContent = cta.href;
        raw.title = 'Click to copy';
        raw.addEventListener('click', () => copy(cta.href, null));
        li.appendChild(raw);
      }
    } else {
      const none = document.createElement('div');
      none.className = 'no-url';
      none.textContent = 'no url found';
      li.appendChild(none);

      const site = document.createElement('div');
      site.className = 'no-url-site';
      site.textContent = item.viewUrl || '';
      site.title = 'Click to copy';
      site.addEventListener('click', () => copy(item.viewUrl, null));
      li.appendChild(site);
    }

    // always offer a link back to the view page
    const a = document.createElement('a');
    a.className = 'view-link';
    a.href = item.viewUrl;
    a.textContent = 'open in inbox ↗';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(item.viewUrl, '_blank', 'noopener,noreferrer');
    });
    li.appendChild(a);

    list.appendChild(li);
  }
}

function renderHistory(state) {
  const history = Array.isArray(state.history) ? state.history : [];
  const list = $('history-list');
  list.innerHTML = '';

  if (!history.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No address captured yet.';
    list.appendChild(li);
  } else {
    for (const item of history) {
      const li = document.createElement('li');
      li.title = 'Click to copy';

      const val = document.createElement('span');
      val.textContent = item.value;

      const t = document.createElement('span');
      t.className = 'time';
      t.textContent = fmtTime(item.at);

      li.append(val, t);
      li.addEventListener('click', () => copy(item.value, null));
      list.appendChild(li);
    }
  }

  $('count').textContent = `${history.length} saved`;

  const link = $('open-inbox');
  if (state.lastUrl) { link.href = state.lastUrl; link.style.display = ''; }
  else               { link.style.display = 'none'; }
}

async function refresh() {
  const state = await browser.storage.local.get([
    'lastMail','lastMailAt','lastUrl','history','mailItems',
  ]);
  renderAddress(state);
  renderMailList(state);
  renderHistory(state);
}

// --- wiring ----------------------------------------------------------------

$('copy-current').addEventListener('click', (e) => {
  const v = $('current-mail').value;
  if (v) copy(v, e.currentTarget);
});

$('new-address').addEventListener('click', async () => {
  // ask the background to ensure a tab exists and click #click-to-delete
  await browser.runtime.sendMessage({ type: 'newAddress' });
  setTimeout(() => window.close(), 500);
});

$('clear').addEventListener('click', async () => {
  await browser.storage.local.remove(['history']);
  refresh();
});

$('clear-mail').addEventListener('click', async () => {
  await browser.storage.local.remove(['mailItems']);
  refresh();
});

$('open-inbox').addEventListener('click', async (e) => {
  e.preventDefault();
  const { lastUrl } = await browser.storage.local.get('lastUrl');
  if (lastUrl) { window.open(lastUrl, '_blank', 'noopener'); window.close(); }
});

browser.storage.onChanged.addListener(refresh);
refresh();
