const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { status: 'all', q: '', days: 7 };

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('נדרשת התחברות');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'הפעולה נכשלה');
  return data;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

const time = (iso) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

/* ---------- טאבים ---------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== `panel-${tab.dataset.panel}`));
    if (tab.dataset.panel === 'stores') loadStores();
    if (tab.dataset.panel === 'aliases') loadAliases();
    if (tab.dataset.panel === 'settings') loadSettings();
  });
});

$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.href = '/login';
});

/* ---------- סיכום עליון ---------- */

async function loadPulse() {
  const s = await api('/summary');
  const t = s.today || {};
  $('#pulse').innerHTML =
    `היום <b>${t.total || 0}</b> פניות` +
    `<span class="sep">·</span>נמצאו <b>${t.found || 0}</b>` +
    `<span class="sep">·</span>לא נמצאו <b>${t.missed || 0}</b>` +
    `<span class="sep">·</span><b>${s.storesActive}</b> חנויות בהסכם`;
}

/* ---------- זרם הפניות ---------- */

const STATUS = {
  found: { label: 'נמצאה', cls: 'is-found', tag: 'tag-found' },
  confirmed: { label: 'נמצאה, באישור המתקשר', cls: 'is-found', tag: 'tag-found' },
  pending: { label: 'הוצעו אפשרויות', cls: 'is-warn', tag: 'tag-warn' },
  rejected: { label: 'המתקשר דחה את ההצעות', cls: 'is-bad', tag: 'tag-bad' },
  not_found: { label: 'לא נמצאה', cls: 'is-bad', tag: 'tag-bad' },
  empty: { label: 'הדיבור לא נקלט', cls: 'is-bad', tag: 'tag-bad' },
};

function entryHtml(r) {
  const meta = STATUS[r.status] || { label: r.status, cls: '', tag: '' };
  const phone = r.phone ? `<span class="phone">${esc(r.phone)}</span>` : '';
  const src = r.source === 'admin' ? '<span>בדיקה ידנית</span>' : '';
  const attempt = r.attempt > 1 ? `<span>ניסיון ${r.attempt}</span>` : '';

  let verdict;
  if (r.store_id) {
    const agreement = r.enabled
      ? '<span class="tag tag-found">בהסכם פעיל</span>'
      : '<span class="tag tag-warn">ההסכם אינו פעיל</span>';
    verdict = `<b>${esc(r.store_name)}</b> · ${agreement}`;
  } else {
    verdict = `<span class="tag ${meta.tag}">${meta.label}</span>`;
  }

  const alts =
    !r.store_id && r.candidates?.length
      ? `<div class="alt">הכי קרוב במאגר: ${r.candidates
          .slice(0, 3)
          .map((c) => `${esc(c.name)} <span class="score">${Math.round(c.score * 100)}%</span>`)
          .join(' · ')}</div>`
      : '';

  const assign =
    !r.store_id && !r.resolved
      ? `<div class="assign" data-lookup="${r.id}">
           <input class="field assign-q" placeholder="שייכו את «${esc(r.spoken || '')}» לחנות" value="${esc(r.spoken || '')}">
           <button class="mini assign-find">חיפוש</button>
           <ul class="suggestions"></ul>
         </div>`
      : '';

  return `<article class="entry ${meta.cls}">
    <div class="entry-meta"><span>${time(r.created_at)}</span>${phone}${attempt}${src}</div>
    <p class="spoken">«${esc(r.spoken || '—')}»</p>
    <div class="verdict">${verdict} ${r.score ? `<span class="score">התאמה ${Math.round(r.score * 100)}%</span>` : ''}</div>
    ${alts}${assign}
  </article>`;
}

async function loadFeed() {
  const params = new URLSearchParams({ status: state.status, limit: '150' });
  if (state.q) params.set('q', state.q);
  if (state.days) params.set('from', new Date(Date.now() - state.days * 864e5).toISOString());

  const { rows, total } = await api(`/lookups?${params}`);
  const feed = $('#feed');

  if (!rows.length) {
    feed.innerHTML = `<div class="empty"><b>אין פניות להצגה</b>שנו את הסינון, או התקשרו לשלוחה כדי לבדוק חנות.</div>`;
    return;
  }
  feed.innerHTML = rows.map(entryHtml).join('');
  if (total > rows.length) {
    feed.insertAdjacentHTML('beforeend', `<div class="empty">מוצגות ${rows.length} מתוך ${total} פניות</div>`);
  }
}

/* שיוך חנות מתוך פנייה שנכשלה */
$('#feed').addEventListener('click', async (e) => {
  const box = e.target.closest('.assign');
  if (!box) return;

  if (e.target.classList.contains('assign-find')) {
    const q = box.querySelector('.assign-q').value.trim();
    if (!q) return;
    const list = await api(`/stores?q=${encodeURIComponent(q)}&limit=6`);
    box.querySelector('.suggestions').innerHTML = list.length
      ? list
          .map(
            (s) =>
              `<li><button data-id="${esc(s.store_id)}">${esc(s.store_name)}${
                s.enabled ? '' : ' — ההסכם אינו פעיל'
              }</button></li>`
          )
          .join('')
      : '<li><button disabled>לא נמצאה חנות מתאימה</button></li>';
    return;
  }

  const pick = e.target.closest('.suggestions button[data-id]');
  if (pick) {
    await api('/aliases', {
      method: 'POST',
      body: {
        alias: box.querySelector('.assign-q').value.trim(),
        store_id: pick.dataset.id,
        lookup_id: Number(box.dataset.lookup),
      },
    });
    toast('הכינוי נשמר');
    loadFeed();
  }
});

/* ---------- חנויות ובדיקה ---------- */

async function loadStores() {
  const q = $('#storeQ').value.trim();
  const list = await api(`/stores?limit=80${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  $('#stores').innerHTML = list.length
    ? list
        .map(
          (s) => `<div class="row">
            <span class="grow">${esc(s.store_name)}</span>
            ${s.score ? `<span class="muted">${Math.round(s.score * 100)}%</span>` : ''}
            <span class="badge ${s.enabled ? 'badge-ok' : 'badge-warn'}">${s.enabled ? 'בהסכם' : 'הסכם פג'}</span>
            <span class="muted">${esc(s.store_id)}</span>
          </div>`
        )
        .join('')
    : `<div class="empty"><b>אין חנויות להצגה</b>הריצו סנכרון מול נדרים בלשונית ההגדרות.</div>`;
}

$('#storeQ').addEventListener('input', debounce(loadStores, 250));

$('#testRun').addEventListener('click', async () => {
  const text = $('#testText').value.trim();
  if (!text) return;
  const r = await api('/test', { method: 'POST', body: { text } });
  const verdict =
    r.decision === 'auto'
      ? `<span class="tag tag-found">תענה מיד: ${esc(r.store.store_name)}</span>`
      : r.decision === 'confirm'
        ? `<span class="tag tag-warn">תשאל את המתקשר לאישור</span>`
        : `<span class="tag tag-bad">תענה שלא נמצאה</span>`;
  $('#testOut').innerHTML = `<div class="alt">${verdict}
    ${r.candidates.length ? '<br>' + r.candidates.map((c) => `${esc(c.store_name)} <span class="score">${Math.round(c.score * 100)}%</span>`).join(' · ') : ''}
  </div>`;
});

$('#testText').addEventListener('keydown', (e) => e.key === 'Enter' && $('#testRun').click());

/* ---------- כינויים ---------- */

async function loadAliases() {
  const list = await api('/aliases');
  $('#aliases').innerHTML = list.length
    ? list
        .map(
          (a) => `<div class="row">
            <span class="grow">«${esc(a.alias)}» ← <b>${esc(a.store_name || a.store_id)}</b></span>
            <span class="muted">${new Date(a.created_at).toLocaleDateString('he-IL')}</span>
            <button class="mini" data-del="${a.id}">מחיקה</button>
          </div>`
        )
        .join('')
    : `<div class="empty"><b>אין כינויים</b>הוסיפו כינוי מתוך פנייה שלא זוהתה בלשונית הפניות.</div>`;
}

$('#aliases').addEventListener('click', async (e) => {
  const id = e.target.dataset?.del;
  if (!id) return;
  await api(`/aliases/${id}`, { method: 'DELETE' });
  toast('הכינוי נמחק');
  loadAliases();
});

/* ---------- הגדרות ---------- */

async function loadSettings() {
  const [s, cfg] = await Promise.all([api('/summary'), api('/settings')]);
  const last = s.lastSync;
  $('#syncInfo').innerHTML = last
    ? `סנכרון אחרון: <b>${new Date(last.finished_at || last.started_at).toLocaleString('he-IL')}</b> — ` +
      (last.ok
        ? `${last.stores} חנויות (חדשות ${last.added}, שונו ${last.changed}, ירדו מהרשימה ${last.removed})`
        : `<span class="tag tag-bad">נכשל: ${esc(last.message || '')}</span>`)
    : 'עדיין לא בוצע סנכרון.';

  $('#scope').innerHTML =
    `<option value="all">כל החנויות בהסכם (${s.storesActive})</option>` +
    cfg.groups
      .map((g) => `<option value="${esc(g.group_id)}">${esc(g.group_name)}</option>`)
      .join('');
  $('#scope').value = cfg.scope;
}

$('#syncNow').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'מסנכרן…';
  const r = await api('/sync', { method: 'POST' });
  toast(r.ok ? `סונכרנו ${r.total} חנויות` : `הסנכרון נכשל: ${r.message}`);
  e.target.disabled = false;
  e.target.textContent = 'סנכרון עכשיו';
  loadSettings();
  loadPulse();
});

$('#scope').addEventListener('change', async (e) => {
  await api('/settings', { method: 'POST', body: { scope: e.target.value } });
  toast('ההגדרה נשמרה');
});

/* ---------- סינון ---------- */

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    state.status = chip.dataset.status;
    loadFeed();
  });
});

$('#range').addEventListener('change', (e) => {
  state.days = Number(e.target.value);
  loadFeed();
});

$('#q').addEventListener(
  'input',
  debounce((e) => {
    state.q = e.target.value.trim();
    loadFeed();
  }, 300)
);

$('#csv').addEventListener('click', () => {
  const params = new URLSearchParams({ status: state.status });
  if (state.q) params.set('q', state.q);
  if (state.days) params.set('from', new Date(Date.now() - state.days * 864e5).toISOString());
  location.href = `/api/lookups.csv?${params}`;
});

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------- אתחול ---------- */

loadPulse().catch(() => {});
loadFeed().catch((e) => toast(e.message));
setInterval(() => {
  if (!document.hidden && $('#panel-feed').hidden === false) {
    loadPulse().catch(() => {});
    loadFeed().catch(() => {});
  }
}, 30000);
