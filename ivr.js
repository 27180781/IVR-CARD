import express from 'express';
import { cfg } from './config.js';
import { searchPool, allAliases, saveLookup, nowIso } from './db.js';
import { rankStores, decide } from './matcher.js';

export const ivrRouter = express.Router();

/* ---------- עזרי טקסט לדיבור ---------- */
// לפי התיעוד: כל מחרוזת text מסונתזת פעם אחת ונשמרת במטמון.
// לכן משפטים קצרים וחוזרים, ולא פסקה אחת ארוכה.

const V = cfg.ttsVoice;
const say = (text) => (V ? { text, voice: V } : { text });

const LINES = {
  welcome: 'שלום, זהו קו בדיקת חנויות נדרים קארד.',
  ask: 'אמרו את שם החנות אחרי הצפצוף.',
  askAgain: 'אמרו את שם החנות.',
  notHeard: 'לא הצלחנו לקלוט את שם החנות.',
  theStore: 'החנות',
  approved: 'נמצאת ברשימת החנויות המאושרות.',
  inactive: 'קיימת במערכת, אך ההסכם מולה אינו פעיל.',
  noStoreNamed: 'לא נמצאה חנות בשם',
  didYouMean: 'האם התכוונתם ל',
  press1: 'הקישו 1.',
  press2: 'הקישו 2.',
  press3: 'הקישו 3.',
  none: 'אם אף אחת מהאפשרויות אינה נכונה, הקישו 9.',
  againMenu: 'לבדיקת חנות נוספת הקישו 1.',
  endMenu: 'לסיום הקישו 2.',
  bye: 'תודה ולהתראות.',
  error: 'אירעה תקלה זמנית. נסו שוב מאוחר יותר.',
};

const KEY_LINE = [null, LINES.press1, LINES.press2, LINES.press3];

/* ---------- מודולים ---------- */

const sttModule = (i, first) => ({
  type: 'stt',
  name: `say${i}`,
  max: Math.min(cfg.sttSeconds, 10), // מגבלת המערכת: 10 שניות
  min: 1,
  fileName: `store_{{PBXphone}}_{{PBXcallId}}_${i}`,
  files: first ? [say(LINES.welcome), say(LINES.ask)] : [say(LINES.askAgain)],
});

const confirmMenu = (i, candidates) => ({
  type: 'simpleMenu',
  name: `conf${i}`,
  enabledKeys: [...candidates.map((_, n) => String(n + 1)), '9'].join(','),
  times: 2,
  timeout: 6,
  errorReturn: '9',
  files: [
    say(LINES.didYouMean),
    ...candidates.flatMap((c, n) => [say(c.store_name), say(KEY_LINE[n + 1])]),
    say(LINES.none),
  ],
});

const goodbye = () => [{ type: 'simpleMessage', files: [say(LINES.bye)] }, { type: 'hangup' }];

const moreMenu = (i, last) =>
  last
    ? { type: 'simpleMessage', files: [say(LINES.bye)] }
    : {
        type: 'simpleMenu',
        name: `more${i}`,
        enabledKeys: '1,2',
        times: 2,
        timeout: 6,
        errorReturn: '2',
        files: [say(LINES.againMenu), say(LINES.endMenu)],
      };

const verdictFiles = (store) => [
  say(LINES.theStore),
  say(store.store_name),
  say(store.enabled ? LINES.approved : LINES.inactive),
];

/* ---------- לוגיקה ---------- */

function resolve(spoken) {
  const text = String(spoken ?? '').trim();
  if (!text || text.length < 2) return { kind: 'empty', query: '', candidates: [] };
  const { query, candidates } = rankStores(text, searchPool(), allAliases(), { limit: 5 });
  if (!query) return { kind: 'empty', query: '', candidates: [] };
  return { ...decide(candidates, cfg), query, candidates };
}

const slim = (list) =>
  list.map((c) => ({
    id: String(c.store_id),
    name: c.store_name,
    enabled: !!c.enabled,
    score: c.score,
    via: c.via || undefined,
  }));

function log(p, i, spoken, res, status, store) {
  saveLookup({
    created_at: nowIso(),
    phone: p.PBXphone,
    call_id: p.PBXcallId,
    extension: p.PBXextensionId || p.PBXextensionPath,
    attempt: i,
    spoken,
    query: res.query,
    status,
    store_id: store ? String(store.store_id) : null,
    store_name: store ? store.store_name : null,
    enabled: store ? !!store.enabled : null,
    score: store ? store.score : res.candidates[0]?.score ?? null,
    candidates: slim(res.candidates),
    source: 'ivr',
    recording: p[`PATH_say${i}`] || p[`FILE_say${i}`] || null,
    duration: p[`DURATION_say${i}`] ? Number(p[`DURATION_say${i}`]) : null,
  });
}

ivrRouter.all('/', (req, res) => {
  res.set('Content-Type', 'application/json; charset=utf-8');
  const p = { ...req.query, ...(req.body || {}) };

  if (cfg.ivrToken && p.token !== cfg.ivrToken) {
    return res.status(200).json({ type: 'hangup' });
  }

  // סיום שיחה — מחזירים 200 ריק, בלי מודול
  if (p.PBXcallStatus === 'HANGUP') {
    return res.status(200).json({});
  }

  try {
    const max = Math.max(1, cfg.maxAttempts);

    for (let i = 1; i <= max; i++) {
      const spoken = p[`say${i}`];

      // 1. עוד לא שאלנו בניסיון הזה
      if (spoken === undefined) {
        return res.json(sttModule(i, i === 1));
      }

      const result = resolve(spoken);
      const conf = p[`conf${i}`];
      const more = p[`more${i}`];
      const last = i === max;

      // 2. צריך אישור מהמתקשר ועוד לא קיבלנו
      if (result.kind === 'confirm' && conf === undefined) {
        log(p, i, spoken, result, 'pending', null);
        return res.json(confirmMenu(i, result.candidates));
      }

      // 3. מכריזים תוצאה ושואלים אם רוצים עוד
      if (more === undefined) {
        let store = null;
        let status = 'not_found';

        if (result.kind === 'auto') {
          store = result.store;
          status = 'found';
        } else if (result.kind === 'confirm') {
          const idx = Number(conf) - 1;
          if (idx >= 0 && idx < result.candidates.length) {
            store = result.candidates[idx];
            status = 'confirmed';
          } else {
            status = 'rejected';
          }
        } else if (result.kind === 'empty') {
          status = 'empty';
        }

        log(p, i, spoken, result, status, store);

        const files =
          status === 'empty'
            ? [say(LINES.notHeard)]
            : store
              ? verdictFiles(store)
              : [say(LINES.noStoreNamed), say(result.query || String(spoken))];

        const tail = last ? [moreMenu(i, true), { type: 'hangup' }] : [moreMenu(i, false)];
        return res.json([{ type: 'simpleMessage', files }, ...tail]);
      }

      // 4. המתקשר לא רוצה עוד — סוגרים
      if (more !== '1') return res.json(goodbye());
      // אחרת — ממשיכים לניסיון הבא בלולאה
    }

    return res.json(goodbye());
  } catch (err) {
    console.error('[ivr] שגיאה:', err);
    return res.json([{ type: 'simpleMessage', files: [say(LINES.error)] }, { type: 'hangup' }]);
  }
});
