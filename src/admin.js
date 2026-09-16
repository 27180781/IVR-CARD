import crypto from 'node:crypto';
import express from 'express';
import { cfg } from './config.js';
import {
  db,
  listLookups,
  summary,
  searchPool,
  allAliases,
  saveLookup,
  getSetting,
  setSetting,
  nowIso,
} from './db.js';
import { rankStores, decide, normalize } from './matcher.js';
import { runSync } from './nedarim.js';

export const adminRouter = express.Router();

/* ---------- אימות ---------- */

const COOKIE = 'nsc_session';

function sign(value) {
  return crypto.createHmac('sha256', cfg.sessionSecret).update(value).digest('base64url');
}

function issue(user) {
  const exp = Date.now() + cfg.sessionDays * 864e5;
  const payload = `${Buffer.from(user).toString('base64url')}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function verify(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = sign(payload);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(parts[1]) < Date.now()) return null;
  return Buffer.from(parts[0], 'base64url').toString();
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function currentUser(req) {
  return verify(readCookie(req, COOKIE));
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'נדרשת התחברות' });
  req.user = user;
  next();
}

function equalSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const attempts = new Map();

adminRouter.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, until: 0 };
  if (rec.until > now) {
    return res.status(429).json({ error: 'יותר מדי ניסיונות, נסו שוב בעוד דקה' });
  }

  const { user = '', password = '' } = req.body || {};
  const ok = user === cfg.adminUser && cfg.adminPassword && equalSecret(password, cfg.adminPassword);

  if (!ok) {
    rec.n += 1;
    if (rec.n >= 5) {
      rec.until = now + 60000;
      rec.n = 0;
    }
    attempts.set(ip, rec);
    return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
  }

  attempts.delete(ip);
  res.cookie(COOKIE, issue(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https' || req.get('x-forwarded-proto') === 'https',
    maxAge: cfg.sessionDays * 864e5,
  });
  res.json({ ok: true, user });
});

adminRouter.post('/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

adminRouter.get('/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user: user || null });
});

/* ---------- נתונים ---------- */

adminRouter.use(requireAuth);

adminRouter.get('/summary', (req, res) => res.json(summary()));

adminRouter.get('/lookups', (req, res) => {
  res.json(listLookups(req.query));
});

adminRouter.get('/lookups.csv', (req, res) => {
  const { rows } = listLookups({ ...req.query, limit: 5000 });
  const head = ['תאריך', 'שעה', 'טלפון', 'נאמר', 'תוצאה', 'חנות', 'הסכם פעיל', 'ציון', 'מזהה שיחה'];
  const label = {
    found: 'נמצאה',
    confirmed: 'נמצאה (באישור המתקשר)',
    not_found: 'לא נמצאה',
    rejected: 'המתקשר דחה את ההצעות',
    empty: 'לא נקלט',
    pending: 'ממתין לאישור',
  };
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(',')];
  for (const r of rows) {
    const d = new Date(r.created_at);
    lines.push(
      [
        d.toLocaleDateString('he-IL'),
        d.toLocaleTimeString('he-IL'),
        r.phone,
        r.spoken,
        label[r.status] || r.status,
        r.store_name,
        r.store_id ? (r.enabled ? 'כן' : 'לא') : '',
        r.score ?? '',
        r.call_id,
      ]
        .map(esc)
        .join(',')
    );
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="lookups-${Date.now()}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n')); // BOM כדי שאקסל יציג עברית
});

adminRouter.get('/stores', (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  if (!q) {
    return res.json(
      db
        .prepare(
          'SELECT store_id, store_name, enabled, in_list FROM stores WHERE in_list = 1 ORDER BY store_name LIMIT ?'
        )
        .all(limit)
    );
  }
  const pool = db
    .prepare('SELECT store_id, store_name, enabled, in_list, norm FROM stores ORDER BY store_name')
    .all();
  const { candidates } = rankStores(q, pool, [], { limit });
  res.json(candidates);
});

/** ארגז חול: מה המערכת הייתה עונה לטקסט הזה */
adminRouter.post('/test', (req, res) => {
  const text = String(req.body?.text || '');
  const { query, candidates } = rankStores(text, searchPool(), allAliases(), { limit: 5 });
  const d = decide(candidates, cfg);
  const slim = (c) =>
    c && { store_id: c.store_id, store_name: c.store_name, enabled: !!c.enabled, score: c.score, via: c.via };
  res.json({ query, decision: d.kind, candidates: candidates.map(slim), store: slim(d.store) || null });
});

adminRouter.post('/sync', async (req, res) => {
  const result = await runSync('manual');
  res.json(result);
});

/* ---------- כינויים ---------- */

adminRouter.get('/aliases', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT a.*, s.store_name FROM aliases a
         LEFT JOIN stores s ON s.store_id = a.store_id
         ORDER BY a.id DESC`
      )
      .all()
  );
});

adminRouter.post('/aliases', (req, res) => {
  const alias = String(req.body?.alias || '').trim();
  const storeId = String(req.body?.store_id || '').trim();
  if (!alias || !storeId) return res.status(400).json({ error: 'חסרים שם או מזהה חנות' });
  const store = db.prepare('SELECT store_name FROM stores WHERE store_id = ?').get(storeId);
  if (!store) return res.status(404).json({ error: 'החנות לא נמצאה במאגר' });

  db.prepare(
    'INSERT INTO aliases (alias, norm, store_id, created_at, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(alias, normalize(alias), storeId, nowIso(), req.user);

  if (req.body?.lookup_id) {
    db.prepare('UPDATE lookups SET resolved = 1 WHERE id = ?').run(Number(req.body.lookup_id));
  }
  res.json({ ok: true, store_name: store.store_name });
});

adminRouter.delete('/aliases/:id', (req, res) => {
  db.prepare('DELETE FROM aliases WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

/* ---------- הגדרות ---------- */

adminRouter.get('/settings', (req, res) => {
  res.json({
    scope: getSetting('check_scope', 'all'),
    groups: db.prepare('SELECT group_id, group_name FROM store_groups ORDER BY group_name').all(),
  });
});

adminRouter.post('/settings', (req, res) => {
  if (req.body?.scope !== undefined) setSetting('check_scope', String(req.body.scope));
  res.json({ ok: true, scope: getSetting('check_scope', 'all') });
});

/* ---------- בדיקה ידנית שנשמרת ביומן ---------- */

adminRouter.post('/lookups/manual', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'לא הוזן שם' });
  const { query, candidates } = rankStores(text, searchPool(), allAliases(), { limit: 5 });
  const d = decide(candidates, cfg);
  saveLookup({
    phone: req.body?.phone || null,
    call_id: `manual-${Date.now()}`,
    attempt: 1,
    spoken: text,
    query,
    status: d.kind === 'auto' ? 'found' : d.kind === 'confirm' ? 'pending' : 'not_found',
    store_id: d.store ? String(d.store.store_id) : null,
    store_name: d.store ? d.store.store_name : null,
    enabled: d.store ? !!d.store.enabled : null,
    score: candidates[0]?.score ?? null,
    candidates: candidates.map((c) => ({ id: String(c.store_id), name: c.store_name, score: c.score })),
    source: 'admin',
  });
  res.json({ ok: true, decision: d.kind, candidates });
});
