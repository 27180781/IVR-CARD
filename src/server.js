import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { cfg, assertConfig } from './config.js';
import { db, summary } from './db.js';
import { ivrRouter } from './ivr.js';
import { adminRouter, currentUser } from './admin.js';
import { startScheduler } from './nedarim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', true); // מאחורי nginx של קפרובר
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// השלוחה הקולית — Module API של טכנוליין
app.use('/ivr', ivrRouter);

// ממשק הניהול
app.use('/api', adminRouter);

app.get('/healthz', (req, res) => {
  const { c } = db.prepare('SELECT COUNT(*) c FROM stores WHERE in_list = 1').get();
  res.json({ ok: true, stores: c, time: new Date().toISOString() });
});

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { index: false, maxAge: '1h' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, currentUser(req) ? 'index.html' : 'login.html'));
});
app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));

app.use((req, res) => res.status(404).json({ error: 'לא נמצא' }));

const missing = assertConfig();
if (missing.length) {
  console.warn(`[config] חסרים משתני סביבה: ${missing.join(', ')}`);
}

app.listen(cfg.port, () => {
  const s = summary();
  console.log(`[server] מאזין על פורט ${cfg.port} · ${s.stores} חנויות במאגר`);
  startScheduler();
});
