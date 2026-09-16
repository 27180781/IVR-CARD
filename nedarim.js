import { cfg } from './config.js';
import {
  replaceStores,
  replaceGroups,
  startSyncRun,
  finishSyncRun,
  setSetting,
  getSetting,
} from './db.js';

/**
 * לקוח API של נדרים פלוס.
 * לפי התיעוד: ManageReports.aspx, פרמטרים Action / MosadId / ApiPassword.
 * בהצלחה מוחזר JSON של הנתונים; בשגיאה מוחזר Result=Error עם Message,
 * ולפעמים טקסט חשוף במקום JSON — לכן פרסור זהיר.
 */
async function callNedarim(action, extra = {}) {
  if (!cfg.mosadId || !cfg.apiPassword) {
    throw new Error('חסרים NEDARIM_MOSAD_ID או NEDARIM_API_PASSWORD');
  }
  const url = new URL(cfg.nedarimUrl);
  url.searchParams.set('Action', action);
  url.searchParams.set('MosadId', cfg.mosadId);
  url.searchParams.set('ApiPassword', cfg.apiPassword);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let text;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'nedarim-store-checker/1.0' },
      signal: ctrl.signal,
    });
    text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`תשובה שאינה JSON מנדרים: ${text.slice(0, 200)}`);
  }
  if (data && !Array.isArray(data) && String(data.Result || '').toLowerCase() === 'error') {
    throw new Error(data.Message || 'שגיאה לא מזוהה מנדרים');
  }
  return data;
}

/** מאתר את מערך השורות גם כשהוא עטוף במעטפת */
function rowsOf(data, ...keys) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of [...keys, 'Data', 'data', 'Rows', 'rows', 'Result']) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

const truthy = (v) =>
  v === true || v === 1 || ['true', '1', 'yes', 'y'].includes(String(v).trim().toLowerCase());

/** רשימת החנויות: StoreId / StoreName / Enabled */
export async function fetchStores() {
  const data = await callNedarim('GetStoresList');
  const rows = rowsOf(data, 'Stores');
  if (!rows.length) throw new Error('נדרים החזיר רשימת חנויות ריקה');
  return rows
    .map((r) => ({
      store_id: r.StoreId ?? r.storeId ?? r.ID ?? r.Id,
      store_name: r.StoreName ?? r.storeName ?? r.Name ?? '',
      enabled: truthy(r.Enabled ?? r.enabled ?? 1),
    }))
    .filter((r) => r.store_id != null && String(r.store_name).trim());
}

/** קבוצות חנויות: ID / ListName / Stores[] — לא קריטי, נכשל בשקט */
export async function fetchGroups() {
  const data = await callNedarim('GetLimitedStoresList');
  const rows = rowsOf(data, 'Lists', 'Groups');
  return rows
    .map((g) => ({
      id: g.ID ?? g.Id ?? g.id,
      name: g.ListName ?? g.listName ?? '',
      stores: (g.Stores || g.stores || []).map((s) => s.StoreId ?? s.storeId ?? s.ID ?? s),
    }))
    .filter((g) => g.id != null);
}

let running = false;

/** סנכרון מלא: חנויות (חובה) + קבוצות (אופציונלי) */
export async function runSync(trigger = 'scheduled') {
  if (running) return { ok: false, skipped: true, message: 'סנכרון כבר רץ' };
  running = true;
  const runId = startSyncRun(trigger);
  try {
    const stores = await fetchStores();
    const res = replaceStores(stores);

    let groups = 0;
    try {
      groups = replaceGroups(await fetchGroups());
    } catch (err) {
      console.warn('[sync] קבוצות חנויות נכשלו (ממשיכים):', err.message);
    }

    finishSyncRun(runId, {
      ok: true,
      stores: res.total,
      added: res.added,
      removed: res.removed,
      changed: res.changed,
      message: groups ? `${groups} קבוצות` : null,
    });
    setSetting('last_sync_ok', new Date().toISOString());
    console.log(
      `[sync] ${res.total} חנויות (חדשות ${res.added}, שונו ${res.changed}, ירדו מהרשימה ${res.removed})`
    );
    return { ok: true, ...res, groups };
  } catch (err) {
    finishSyncRun(runId, { ok: false, message: err.message });
    console.error('[sync] נכשל:', err.message);
    return { ok: false, message: err.message };
  } finally {
    running = false;
  }
}

export function startScheduler() {
  const ms = Math.max(0.25, cfg.syncHours) * 3600 * 1000;
  const last = getSetting('last_sync_ok');
  const stale = !last || Date.now() - new Date(last).getTime() > ms;

  if (cfg.syncOnBoot && stale) {
    setTimeout(() => runSync('boot'), 4000);
  }
  setInterval(() => runSync('scheduled'), ms);
  console.log(`[sync] מתוזמן כל ${cfg.syncHours} שעות`);
}
