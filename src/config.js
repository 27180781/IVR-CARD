import path from 'node:path';

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const cfg = {
  port: num(process.env.PORT, 80),
  dataDir: process.env.DATA_DIR || '/app/data',

  // נדרים פלוס
  nedarimUrl:
    process.env.NEDARIM_URL ||
    'https://www.matara.pro/nedarimplus/Mechubad/Reports/ManageReports.aspx',
  mosadId: process.env.NEDARIM_MOSAD_ID || '',
  apiPassword: process.env.NEDARIM_API_PASSWORD || '',

  // סנכרון
  syncHours: num(process.env.SYNC_INTERVAL_HOURS, 5),
  syncOnBoot: process.env.SYNC_ON_BOOT !== 'false',

  // שלוחה קולית (Module API של טכנוליין)
  ivrToken: process.env.IVR_TOKEN || '',
  sttSeconds: num(process.env.STT_SECONDS, 7),
  maxAttempts: num(process.env.MAX_ATTEMPTS, 3),
  ttsVoice: process.env.TTS_VOICE || '', // ריק = קול גוגל החינמי

  // ספי התאמה
  autoThreshold: num(process.env.AUTO_THRESHOLD, 0.9),
  confirmThreshold: num(process.env.CONFIRM_THRESHOLD, 0.62),

  // ניהול
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionDays: num(process.env.SESSION_DAYS, 14),
};

cfg.dbFile = path.join(cfg.dataDir, 'stores.db');

export function assertConfig() {
  const missing = [];
  if (!cfg.mosadId) missing.push('NEDARIM_MOSAD_ID');
  if (!cfg.apiPassword) missing.push('NEDARIM_API_PASSWORD');
  if (!cfg.adminPassword) missing.push('ADMIN_PASSWORD');
  if (!cfg.sessionSecret) missing.push('SESSION_SECRET');
  return missing;
}
