/**
 * מנוע התאמת שמות חנויות בעברית.
 *
 * הקלט מגיע מ-STT טלפוני: רועש, בלי ניקוד, עם כתיב חופשי ולפעמים
 * משפט שלם ("אני רוצה לבדוק את סופר ברכה"). לכן ההשוואה נעשית על
 * שלוש רמות: טקסט מנורמל, שלד עיצורים, ורמת מילים.
 */

const FINALS = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };

/** מספר גרסת הנרמול — כשחוקי normalize משתנים, המפתחות השמורים במסד מחושבים מחדש */
export const NORM_VERSION = 2;

/** מילות רעש שה-STT נוטה להוסיף סביב שם החנות */
const FILLER = [
  'אני רוצה לבדוק את',
  'אני רוצה לבדוק',
  'רוצה לבדוק את',
  'רוצה לבדוק',
  'תבדוק לי את',
  'תבדוק לי',
  'תבדקי לי',
  'האם החנות',
  'האם יש את',
  'האם קיימת',
  'האם קיים',
  'שם החנות הוא',
  'שם החנות',
  'החנות נקראת',
  'קוראים לה',
  'בבקשה',
  'תודה',
];

/** מילים גנריות שלא נושאות מידע מזהה בפני עצמן */
const WEAK_TOKENS = new Set(['חנות', 'החנות', 'בחנות', 'בית', 'עסק', 'של', 'את', 'ה', 'ב', 'ו']);

/** ניקוד, טעמים, גרשיים, מקף ותווי פיסוק → החוצה; אותיות סופיות → רגילות */
export function normalize(text) {
  if (text == null) return '';
  let s = String(text);
  s = s.normalize('NFKD').replace(/[\u0591-\u05C7]/g, ''); // ניקוד וטעמי מקרא
  s = s.replace(/[׳״'"`\u2018\u2019\u201C\u201D]/g, ''); // גרש/גרשיים
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' '); // כל השאר → רווח
  s = s.replace(/[ךםןףץ]/g, (c) => FINALS[c]);
  s = s.toLowerCase(); // שמות לטיניים: Fox ו-FOX זהים
  return s.replace(/\s+/g, ' ').trim();
}

/** מסיר את מילות הרעש מהקצוות ומהאמצע */
export function stripFiller(norm) {
  let s = ` ${norm} `;
  for (const phrase of FILLER) {
    s = s.split(` ${normalize(phrase)} `).join(' ');
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s || norm;
}

/**
 * שלד עיצורים: מוריד אמות קריאה (א ה ו י ע) ורווחים.
 * "רמי לוי" ו-"רמי לווי" ו-"רמילוי" מתכנסים לאותו מפתח.
 */
export function skeleton(norm) {
  return norm.replace(/[אהויע]/g, '').replace(/\s+/g, '');
}

/** מפתח פונטי גס: אותיות שנשמעות דומה בטלפון מתמזגות */
export function phonetic(norm) {
  return norm
    .replace(/ט/g, 'ת')
    .replace(/[חכ]/g, 'ק')
    .replace(/ב/g, 'ו')
    .replace(/ש/g, 'ס')
    .replace(/\s+/g, '');
}

function bigrams(s) {
  const out = new Map();
  const t = s.replace(/\s+/g, '');
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** מקדם Dice על ביגרמות — עמיד להיפוך סדר מילים */
export function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let sizeA = 0;
  let sizeB = 0;
  let inter = 0;
  for (const n of A.values()) sizeA += n;
  for (const [g, n] of B) {
    sizeB += n;
    const m = A.get(g);
    if (m) inter += Math.min(m, n);
  }
  if (!sizeA || !sizeB) return a === b ? 1 : 0;
  return (2 * inter) / (sizeA + sizeB);
}

/** מרחק לוינשטיין עם מגבלת זיכרון נמוכה */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur.slice();
  }
  return prev[b.length];
}

export function levSim(a, b) {
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length);
  return max ? 1 - levenshtein(a, b) / max : 0;
}

function tokens(norm) {
  return norm.split(' ').filter((t) => t && !WEAK_TOKENS.has(t));
}

/** התאמה ברמת מילים: כמה ממילות השאילתה מצאו מקבילה בשם החנות */
function tokenScore(qTokens, tTokens) {
  if (!qTokens.length || !tTokens.length) return 0;
  let hit = 0;
  for (const q of qTokens) {
    let best = 0;
    for (const t of tTokens) {
      if (q === t) {
        best = 1;
        break;
      }
      const s = Math.max(levSim(q, t), levSim(skeleton(q), skeleton(t)) * 0.95);
      if (s > best) best = s;
    }
    if (best >= 0.78) hit += best;
  }
  const coverage = hit / qTokens.length;
  const density = hit / tTokens.length;
  // ממוצע משוקלל: חשוב יותר שכל מה שנאמר נמצא, מאשר שכל שם החנות כוסה
  return coverage * 0.7 + Math.min(density, 1) * 0.3;
}

function containment(a, b) {
  if (!a || !b) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3) return 0;
  const padded = ` ${long} `;
  const whole = padded.includes(` ${short} `);
  if (!whole && !long.includes(short)) return 0;
  // "רמי לוי" בתוך "רמי לוי שיווק השקמה" — פתיחת שם של רשת היא סימן חזק במיוחד
  const atStart = long === short || long.startsWith(`${short} `);
  const base = atStart ? 0.88 : whole ? 0.82 : 0.72;
  return Math.min(0.97, base + 0.15 * (short.length / long.length));
}

/** ציון התאמה יחיד בין שאילתה מנורמלת לשם חנות מנורמל (0..1) */
export function similarity(qNorm, tNorm) {
  if (!qNorm || !tNorm) return 0;
  if (qNorm === tNorm) return 1;

  const qSkel = skeleton(qNorm);
  const tSkel = skeleton(tNorm);
  if (qSkel.length >= 2 && qSkel === tSkel) return 0.98;

  const scores = [
    dice(qNorm, tNorm),
    levSim(qNorm.replace(/\s+/g, ''), tNorm.replace(/\s+/g, '')),
    containment(qNorm, tNorm),
    tokenScore(tokens(qNorm), tokens(tNorm)),
  ];

  if (qSkel.length >= 3 && tSkel.length >= 3) {
    scores.push(dice(qSkel, tSkel) * 0.95, levSim(qSkel, tSkel) * 0.95);
  }

  const qPhon = phonetic(qNorm);
  const tPhon = phonetic(tNorm);
  if (qPhon.length >= 3 && tPhon.length >= 3) {
    scores.push(levSim(qPhon, tPhon) * 0.93);
  }

  return Math.max(...scores);
}

const HEB = /[\u0590-\u05FF]/;
const LAT = /[a-z]/;

/**
 * שם דו-לשוני ("REAL MAN - ריל מן") מפוצל לחלק העברי ולחלק הלטיני,
 * כדי שמי שאומר "ריל מן" יקבל התאמה מלאה ולא חלקית.
 * מספרים נשארים בשני החלקים, כך ש"מעיין 2000" לא נחשב דו-לשוני.
 */
export function scriptParts(norm) {
  if (!HEB.test(norm) || !LAT.test(norm)) return [];
  const words = norm.split(' ').filter(Boolean);
  const heb = words.filter((w) => !LAT.test(w));
  const lat = words.filter((w) => !HEB.test(w));
  const parts = [];
  for (const p of [heb, lat]) {
    if (!p.length || p.length === words.length) continue;
    const joined = p.join(' ');
    if (joined.replace(/\s/g, '').length >= 2) parts.push(joined);
  }
  return parts;
}

/**
 * מדרג רשימת חנויות מול טקסט שנאמר.
 * stores: [{ store_id, store_name, enabled, norm, skel }]
 * aliases: [{ alias, norm, store_id }] — כינויים שהוגדרו ידנית באתר הניהול
 */
export function rankStores(spoken, stores, aliases = [], opts = {}) {
  const limit = opts.limit || 5;
  const raw = normalize(spoken);
  const query = stripFiller(raw);
  if (!query) return { query: '', raw, candidates: [] };

  const byId = new Map(stores.map((s) => [String(s.store_id), s]));
  const boost = new Map();

  for (const a of aliases) {
    const aNorm = a.norm || normalize(a.alias);
    if (!aNorm) continue;
    const s = similarity(query, aNorm);
    if (s <= 0) continue;
    const id = String(a.store_id);
    // כינוי מדויק גובר על כל התאמה מחושבת
    const value = s >= 0.995 ? 1 : Math.min(0.99, s + 0.05);
    if (!boost.has(id) || boost.get(id).score < value) {
      boost.set(id, { score: value, via: a.alias });
    }
  }

  const scored = [];
  for (const s of stores) {
    const tNorm = s.norm || normalize(s.store_name);
    let score = similarity(query, tNorm);
    // התאמה לחלק אחד של שם דו-לשוני שווה כמעט כמו התאמה מלאה
    for (const part of scriptParts(tNorm)) {
      score = Math.max(score, similarity(query, part) * 0.995);
    }
    let via = null;
    const b = boost.get(String(s.store_id));
    if (b && b.score > score) {
      score = b.score;
      via = b.via;
    }
    if (score >= 0.35) scored.push({ ...s, score: Number(score.toFixed(4)), via });
  }

  for (const [id, b] of boost) {
    if (!scored.some((s) => String(s.store_id) === id) && byId.has(id)) {
      const s = byId.get(id);
      scored.push({ ...s, score: Number(b.score.toFixed(4)), via: b.via });
    }
  }

  // כפילויות בנדרים (רשומה ישנה מושבתת לצד רשומה פעילה באותו שם):
  // מציגים אחת בלבד, עדיפות לפעילה, כדי לא לשאול "מימו או מימו?"
  const byNorm = new Map();
  for (const c of scored) {
    const key = c.norm || normalize(c.store_name);
    const prev = byNorm.get(key);
    const better =
      !prev ||
      (!!c.enabled && !prev.enabled) ||
      (!!c.enabled === !!prev.enabled && c.score > prev.score);
    if (better) byNorm.set(key, c);
  }
  const unique = [...byNorm.values()];

  unique.sort((a, b) => b.score - a.score || a.store_name.localeCompare(b.store_name, 'he'));
  return { query, raw, candidates: unique.slice(0, limit) };
}

/**
 * מחליט מה לעשות עם הדירוג:
 *  auto    — התאמה חד-משמעית, אפשר להכריז
 *  confirm — יש מועמדים סבירים, צריך לשאול את המתקשר
 *  none    — לא נמצא
 */
export function decide(candidates, { autoThreshold = 0.9, confirmThreshold = 0.62 } = {}) {
  if (!candidates.length) return { kind: 'none', candidates: [] };
  const [top, second] = candidates;

  // שם מדויק מנצח גם כשיש סניפים קרובים ("אקסוס" מול "אקסוס צפת"),
  // אלא אם הרשומה המדויקת מושבתת ויש חלופה פעילה סבירה — אז שואלים.
  const exact = top.score >= 0.999 && (!second || second.score < 0.999);
  const activeAlt = candidates.some((c, i) => i > 0 && c.enabled && c.score >= confirmThreshold);
  if (exact && (top.enabled || !activeAlt)) return { kind: 'auto', store: top, candidates };

  const clear = !second || top.score - second.score >= 0.06;
  if (top.score >= autoThreshold && clear) return { kind: 'auto', store: top, candidates };
  const shortlist = candidates.filter((c) => c.score >= confirmThreshold).slice(0, 3);
  if (shortlist.length) return { kind: 'confirm', candidates: shortlist };
  return { kind: 'none', candidates: candidates.slice(0, 3) };
}
