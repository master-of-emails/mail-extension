const $ = (id) => document.getElementById(id);

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = Date.now();
  const diff = (now - ts) / 1000;
  if (diff < 60)    return `${Math.floor(diff)}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = old;
        btn.classList.remove('copied');
      }, 900);
    }
  } catch (e) {
    console.warn('copy failed', e);
  }
}

function render(state) {
  const { lastMail, lastMailAt, history = [], lastUrl } = state;

  // current
  const cur = $('current-mail');
  cur.value = lastMail || '';
  cur.placeholder = lastMail ? '' : 'waiting for mail…';
  $('current-time').textContent = lastMail
    ? `captured ${fmtTime(lastMailAt)}`
    : '';

  // status pill
  const status = $('status');
  const fresh = lastMailAt && (Date.now() - lastMailAt) < 5 * 60 * 1000;
  status.textContent = lastMail ? (fresh ? 'live' : 'stale') : 'idle';
  status.className = 'status ' + (fresh ? 'on' : 'off');

  // history
  const list = $('history-list');
  list.innerHTML = '';

  if (!history.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No mail captured yet.';
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

  // open-inbox link
  const link = $('open-inbox');
  if (lastUrl) {
    link.href = lastUrl;
    link.style.display = '';
  } else {
    link.style.display = 'none';
  }
}

async function refresh() {
  const state = await browser.storage.local.get([
    'lastMail', 'lastMailAt', 'history', 'lastUrl',
  ]);
  render(state);
}

// --- wire up ---
$('copy-current').addEventListener('click', (e) => {
  const v = $('current-mail').value;
  if (v) copy(v, e.currentTarget);
});

$('clear').addEventListener('click', async () => {
  await browser.storage.local.remove(['history']);
  refresh();
});

$('open-inbox').addEventListener('click', async (e) => {
  e.preventDefault();
  const { lastUrl } = await browser.storage.local.get('lastUrl');
  if (lastUrl) {
    browser.tabs.create({ url: lastUrl });
    window.close();
  }
});

// live-update while popup is open
browser.storage.onChanged.addListener(refresh);

refresh();
