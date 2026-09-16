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
