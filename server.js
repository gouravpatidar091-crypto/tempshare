// ============================================================
// server.js — TempShare entry point
// ============================================================

const express    = require('express');
const path       = require('path');
const cors       = require('cors');
const compression = require('compression');
const rateLimit  = require('express-rate-limit');
const cron       = require('node-cron');
const fs         = require('fs');

const { router, cleanExpiredFiles } = require('./routes');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Ensure /uploads dir exists ────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── Middleware ────────────────────────────────────────────────
app.use(compression());   // gzip all responses
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve static assets (HTML / JS / CSS)
app.use(express.static(path.join(__dirname, 'public')));

// ── Global rate limiter ───────────────────────────────────────
const limiter = rateLimit({
  windowMs : 15 * 60 * 1000,   // 15 minutes
  max      : 100,               // max 100 req per window per IP
  standardHeaders: true,
  legacyHeaders  : false,
  message  : { error: 'Too many requests, please try again later.' }
});
app.use(limiter);

// Tighter limit just for uploads
const uploadLimiter = rateLimit({
  windowMs : 60 * 60 * 1000,   // 1 hour
  max      : 20,                // 20 uploads per IP per hour
  message  : { error: 'Upload limit reached. Try again in an hour.' }
});
app.use('/api/upload', uploadLimiter);

// ── API routes ───────────────────────────────────────────────
app.use('/', router);

// ── SPA fallback: serve index.html for /download/* pages ─────
app.get('/download/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 404 handler ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// ── Cron: clean expired files every hour ─────────────────────
cron.schedule('0 * * * *', () => {
  console.log('[CRON] Running cleanup…');
  cleanExpiredFiles();
});

// ── Boot ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  TempShare running → http://localhost:${PORT}`);
});

