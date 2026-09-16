import test from 'node:test';
import assert from 'node:assert/strict';
import { rankStores, decide, normalize, skeleton } from '../src/matcher.js';

const STORES = [
  'סופר ברכה', 'רמי לוי שיווק השקמה', 'יש חסד', 'ויקטורי', 'אושר עד',
  'זול ובגדול', 'מחסני השוק', 'טיב טעם', 'שופרסל דיל', 'סופר פארם',
  'בית המאפה הרצוג', 'מרכול אליהו', 'כל בו חזן', 'פיצוחי הבירה',
  'חנות הבגדים של רבקי', 'מגה בעיר', 'קינג סטור', 'ביג דיל',
].map((n, i) => ({ store_id: String(i + 1), store_name: n, enabled: i % 7 !== 3, norm: normalize(n), skel: skeleton(normalize(n)) }));

const opts = { autoThreshold: 0.9, confirmThreshold: 0.62 };

function ask(text, aliases = []) {
  const { candidates, query } = rankStores(text, STORES, aliases);
  return { ...decide(candidates, opts), query, candidates };
}

test('שם מדויק → תשובה מיידית', () => {
  const r = ask('סופר ברכה');
  assert.equal(r.kind, 'auto');
  assert.equal(r.store.store_name, 'סופר ברכה');
});

test('משפט שלם סביב השם', () => {
  const r = ask('אני רוצה לבדוק את החנות אושר עד בבקשה');
  assert.equal(r.kind, 'auto', JSON.stringify(r.candidates?.slice(0,2)));
  assert.equal(r.store.store_name, 'אושר עד');
});

test('שם חלקי של רשת ארוכה', () => {
  const r = ask('רמי לוי');
  assert.ok(['auto', 'confirm'].includes(r.kind));
  const top = r.store || r.candidates[0];
  assert.equal(top.store_name, 'רמי לוי שיווק השקמה');
});

test('כתיב מלא מול חסר', () => {
  const r = ask('ויקטוריה');
  assert.ok(r.candidates[0].store_name === 'ויקטורי', JSON.stringify(r.candidates[0]));
});

test('שגיאת תעתיק של STT', () => {
  const r = ask('טיב טעם'); // תקין
  assert.equal(r.kind, 'auto');
  const r2 = ask('תיב תעם'); // ט/ת מתחלפות
  assert.ok(r2.kind !== 'none', JSON.stringify(r2.candidates.slice(0,2)));
});

test('שם שלא קיים → לא נמצא', () => {
  const r = ask('מכולת פרדס כץ של משה');
  assert.equal(r.kind, 'none', JSON.stringify(r.candidates.slice(0,3)));
});

test('כינוי ידני גובר', () => {
  const aliases = [{ alias: 'החנות של רבקי', norm: normalize('החנות של רבקי'), store_id: '15' }];
  const r = ask('החנות של רבקי', aliases);
  assert.equal(r.kind, 'auto');
  assert.equal(r.store.store_id, '15');
});

test('שם דו-משמעי → בקשת אישור', () => {
  const r = ask('דיל');
  assert.ok(r.kind === 'confirm' || r.kind === 'none', r.kind);
});

test('קלט ריק', () => {
  const { candidates } = rankStores('', STORES, []);
  assert.equal(candidates.length, 0);
});

/* ---------- שמות אמיתיים מרשימת נדרים ---------- */

const REAL = [
  ['930', 'CHEMISE', true], ['475', 'FINE WEAR', true],
  ['464', 'REAL MAN - ריל מן', true], ['325', 'BAGIR בגיר', true],
  ['923', 'מימו', true], ['610', 'מימו', false], ['1284', 'גוונים', true], ['661', 'גוונים', true],
  ['552', 'אקסוס', true], ['442', 'אקסוס טבריה', true], ['662', 'אקסוס צפת', true], ['488', 'אקסוס אלעד', true],
  ['786', 'סי יו', true], ['1016', 'סי יו cuwear', true],
  ['349', 'מאפיית נחמה', false], ['954', 'מאפיית נחמה - בית שמש', true], ['1286', 'קרפור', false],
  ['302', 'מעיין 2000', true], ['539', "מעיין בית - קינג ג'ורג'", true],
].map(([id, n, en]) => ({ store_id: id, store_name: n, enabled: en, norm: normalize(n), skel: skeleton(normalize(n)) }));

function askReal(text, aliases = []) {
  const { candidates } = rankStores(text, REAL, aliases);
  return { ...decide(candidates, opts), candidates };
}

test('אותיות לטיניות: גודל האות לא משנה', () => {
  assert.equal(normalize('Fine Wear'), normalize('FINE WEAR'));
  const r = askReal('fine wear');
  assert.equal(r.kind, 'auto');
  assert.equal(r.store.store_name, 'FINE WEAR');
});

test('כפילות באותו שם: מוצגת פעם אחת, הפעילה קודמת', () => {
  const r = askReal('מימו');
  assert.equal(r.kind, 'auto', JSON.stringify(r.candidates));
  assert.equal(r.store.store_id, '923');
  assert.equal(r.candidates.filter((c) => c.norm === normalize('מימו')).length, 1);
  assert.equal(askReal('גוונים').kind, 'auto');
});

test('שם מדויק מנצח סניפים קרובים', () => {
  const r = askReal('אקסוס');
  assert.equal(r.kind, 'auto', JSON.stringify(r.candidates.slice(0, 2)));
  assert.equal(r.store.store_name, 'אקסוס');
  const t = askReal('אקסוס טבריה');
  assert.equal(t.kind, 'auto');
  assert.equal(t.store.store_name, 'אקסוס טבריה');
});

test('שם דו-לשוני: החלק העברי מספיק', () => {
  const r = askReal('ריל מן');
  assert.equal(r.kind, 'auto', JSON.stringify(r.candidates.slice(0, 2)));
  assert.equal(r.store.store_name, 'REAL MAN - ריל מן');
  assert.equal(askReal('בגיר').kind, 'auto');
  const s = askReal('סי יו');
  assert.equal(s.kind, 'auto');
  assert.equal(s.store.store_name, 'סי יו'); // ההתאמה המלאה גוברת על החלקית
});

test('רשומה מדויקת מושבתת לא מסתירה סניף פעיל', () => {
  const r = askReal('מאפיית נחמה');
  assert.equal(r.kind, 'confirm');
  assert.ok(r.candidates.some((c) => c.store_name === 'מאפיית נחמה - בית שמש'));
  const k = askReal('קרפור'); // אין חלופה פעילה — מכריזים, והקו יאמר שההסכם אינו פעיל
  assert.equal(k.kind, 'auto');
  assert.equal(k.store.enabled, false);
});

test('מספר בשם עברי לא נחשב חלק לטיני', () => {
  assert.notEqual(askReal('מעיין').kind, 'auto'); // "מעיין 2000" ו"מעיין בית" — צריך לשאול
});

test('שם באנגלית בלבד: לא נמצא בלי כינוי, נמצא איתו', () => {
  assert.equal(askReal('שמיז').kind, 'none');
  const r = askReal('שמיז', [{ alias: 'שמיז', store_id: '930' }]);
  assert.equal(r.kind, 'auto');
  assert.equal(r.store.store_name, 'CHEMISE');
});
