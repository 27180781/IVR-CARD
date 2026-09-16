import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { cfg } from './config.js';
import { normalize, skeleton } from './matcher.js';

fs.mkdirSync(path.dirname(cfg.dbFile), { recursive: true });

export const db = new Database(cfg.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS stores (
  store_id   TEXT PRIMARY KEY,
  store_name TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  in_list    INTEGER NOT NULL DEFAULT 1,
  norm       TEXT NOT NULL DEFAULT '',
  skel       TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_groups (
  group_id   TEXT PRIMARY KEY,
  group_name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_group_members (
  group_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  PRIMARY KEY (group_id, store_id)
);

CREATE TABLE IF NOT EXISTS aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  alias      TEXT NOT NULL,
  norm       TEXT NOT NULL,
  store_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_aliases_store ON aliases(store_id);

CREATE TABLE IF NOT EXISTS lookups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL,
  phone         TEXT,
  call_id       TEXT,
  extension     TEXT,
  attempt       INTEGER NOT NULL DEFAULT 1,
  spoken        TEXT,
  query         TEXT,
  status        TEXT NOT NULL,
  store_id      TEXT,
  store_name    TEXT,
  enabled       INTEGER,
  score         REAL,
  candidates    TEXT,
  source        TEXT NOT NULL DEFAULT 'ivr',
  recording     TEXT,
  duration      REAL,
  resolved      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lookups_call ON lookups(call_id, attempt, source);
CREATE INDEX IF NOT EXISTS idx_lookups_created ON lookups(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lookups_status ON lookups(status);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER,
  stores      INTEGER,
  added       INTEGER,
  removed     INTEGER,
  changed     INTEGER,
  message     TEXT,
  trigger     TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

export const nowIso = () => new Date().toISOString();

/* ---------- הגדרות ---------- */

export function getSetting(key, def = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value == null ? null : String(value));
}

/* ---------- חנויות ---------- */

const upsertStore = db.prepare(`
INSERT INTO stores (store_id, store_name, enabled, in_list, norm, skel, first_seen, last_seen)
VALUES (@store_id, @store_name, @enabled, 1, @norm, @skel, @now, @now)
ON CONFLICT(store_id) DO UPDATE SET
  store_name = excluded.store_name,
  enabled    = excluded.enabled,
  in_list    = 1,
  norm       = excluded.norm,
  skel       = excluded.skel,
  last_seen  = excluded.last_seen
`);

/** כותב את הרשימה שהתקבלה מנדרים ומחזיר סיכום שינויים */
export function replaceStores(rows) {
  const now = nowIso();
  const before = new Map(
    db
      .prepare('SELECT store_id, store_name, enabled, in_list FROM stores')
      .all()
      .map((r) => [String(r.store_id), r])
  );

  const apply = db.transaction((list) => {
    db.prepare('UPDATE stores SET in_list = 0').run();
    for (const r of list) {
      const name = String(r.store_name || '').trim();
      if (!name) continue;
      const norm = normalize(name);
      upsertStore.run({
        store_id: String(r.store_id),
        store_name: name,
        enabled: r.enabled ? 1 : 0,
        norm,
        skel: skeleton(norm),
        now,
      });
    }
  });
  apply(rows);

  let added = 0;
  let changed = 0;
  for (const r of rows) {
    const prev = before.get(String(r.store_id));
    if (!prev || !prev.in_list) added++;
    else if (prev.store_name !== String(r.store_name).trim() || !!prev.enabled !== !!r.enabled) changed++;
  }
  const removed = db.prepare('SELECT COUNT(*) c FROM stores WHERE in_list = 0').get().c;
  return { added, changed, removed, total: rows.length };
}

/** מאגר החיפוש: חנויות פעילות ברשימה, מסוננות לפי קבוצה אם הוגדרה */
export function searchPool() {
  const scope = getSetting('check_scope', 'all');
  if (scope && scope !== 'all') {
    return db
      .prepare(
        `SELECT s.store_id, s.store_name, s.enabled, s.norm, s.skel
         FROM stores s JOIN store_group_members m ON m.store_id = s.store_id
         WHERE s.in_list = 1 AND m.group_id = ?`
      )
      .all(scope);
  }
  return db
    .prepare('SELECT store_id, store_name, enabled, norm, skel FROM stores WHERE in_list = 1')
    .all();
}

export function allAliases() {
  return db.prepare('SELECT id, alias, norm, store_id FROM aliases').all();
}

/* ---------- קבוצות ---------- */

export function replaceGroups(groups) {
  const now = nowIso();
  const apply = db.transaction((list) => {
    db.prepare('DELETE FROM store_group_members').run();
    db.prepare('DELETE FROM store_groups').run();
    const g = db.prepare(
      'INSERT OR REPLACE INTO store_groups (group_id, group_name, updated_at) VALUES (?, ?, ?)'
    );
    const m = db.prepare(
      'INSERT OR IGNORE INTO store_group_members (group_id, store_id) VALUES (?, ?)'
    );
    for (const grp of list) {
      g.run(String(grp.id), String(grp.name || ''), now);
      for (const sid of grp.stores || []) m.run(String(grp.id), String(sid));
    }
  });
  apply(groups);
  return groups.length;
}

/* ---------- יומן פניות ---------- */

const insertLookup = db.prepare(`
INSERT INTO lookups (created_at, phone, call_id, extension, attempt, spoken, query, status,
                     store_id, store_name, enabled, score, candidates, source, recording, duration)
VALUES (@created_at, @phone, @call_id, @extension, @attempt, @spoken, @query, @status,
        @store_id, @store_name, @enabled, @score, @candidates, @source, @recording, @duration)
ON CONFLICT(call_id, attempt, source) DO UPDATE SET
  spoken     = excluded.spoken,
  query      = excluded.query,
  status     = excluded.status,
  store_id   = excluded.store_id,
  store_name = excluded.store_name,
  enabled    = excluded.enabled,
  score      = excluded.score,
  candidates = excluded.candidates,
  recording  = COALESCE(excluded.recording, lookups.recording),
  duration   = COALESCE(excluded.duration, lookups.duration)
`);

export function saveLookup(row) {
  insertLookup.run({
    created_at: row.created_at || nowIso(),
    phone: row.phone || null,
    call_id: row.call_id || null,
    extension: row.extension || null,
    attempt: row.attempt || 1,
    spoken: row.spoken || null,
    query: row.query || null,
    status: row.status,
    store_id: row.store_id || null,
    store_name: row.store_name || null,
    enabled: row.enabled == null ? null : row.enabled ? 1 : 0,
    score: row.score ?? null,
    candidates: row.candidates ? JSON.stringify(row.candidates) : null,
    source: row.source || 'ivr',
    recording: row.recording || null,
    duration: row.duration ?? null,
  });
}

export function listLookups(filters = {}) {
  const where = [];
  const args = {};
  if (filters.from) {
    where.push('created_at >= @from');
    args.from = filters.from;
  }
  if (filters.to) {
    where.push('created_at <= @to');
    args.to = filters.to;
  }
  if (filters.status && filters.status !== 'all') {
    if (filters.status === 'problem') where.push("status IN ('not_found','rejected','empty')");
    else {
      where.push('status = @status');
      args.status = filters.status;
    }
  }
  if (filters.q) {
    where.push('(spoken LIKE @q OR store_name LIKE @q OR phone LIKE @q)');
    args.q = `%${filters.q}%`;
  }
  const sql = `SELECT * FROM lookups ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`;
  args.limit = Math.min(Number(filters.limit) || 100, 1000);
  args.offset = Number(filters.offset) || 0;
  const rows = db.prepare(sql).all(args);
  const countSql = `SELECT COUNT(*) c FROM lookups ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const { c } = db.prepare(countSql).get(args);
  return {
    total: c,
    rows: rows.map((r) => ({ ...r, candidates: r.candidates ? JSON.parse(r.candidates) : [] })),
  };
}

export function summary() {
  const since = (days) => new Date(Date.now() - days * 864e5).toISOString();
  const agg = (from) =>
    db
      .prepare(
        `SELECT
           COUNT(*) total,
           SUM(CASE WHEN status IN ('found','confirmed') THEN 1 ELSE 0 END) found,
           SUM(CASE WHEN status IN ('not_found','rejected','empty') THEN 1 ELSE 0 END) missed,
           COUNT(DISTINCT phone) callers
         FROM lookups WHERE source = 'ivr' AND created_at >= ?`
      )
      .get(from);

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  return {
    today: agg(midnight.toISOString()),
    week: agg(since(7)),
    stores: db.prepare('SELECT COUNT(*) c FROM stores WHERE in_list = 1').get().c,
    storesActive: db.prepare('SELECT COUNT(*) c FROM stores WHERE in_list = 1 AND enabled = 1').get()
      .c,
    aliases: db.prepare('SELECT COUNT(*) c FROM aliases').get().c,
    lastSync: db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() || null,
    scope: getSetting('check_scope', 'all'),
  };
}

/* ---------- ריצות סנכרון ---------- */

export function startSyncRun(trigger) {
  const info = db
    .prepare('INSERT INTO sync_runs (started_at, trigger) VALUES (?, ?)')
    .run(nowIso(), trigger);
  return info.lastInsertRowid;
}

export function finishSyncRun(id, { ok, stores = 0, added = 0, removed = 0, changed = 0, message = null }) {
  db.prepare(
    `UPDATE sync_runs SET finished_at = ?, ok = ?, stores = ?, added = ?, removed = ?, changed = ?, message = ?
     WHERE id = ?`
  ).run(nowIso(), ok ? 1 : 0, stores, added, removed, changed, message, id);
}
