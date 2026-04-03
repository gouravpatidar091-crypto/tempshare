// ============================================================
// routes.js — TempShare with Supabase Storage
// ============================================================

const express  = require('express');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// ── Supabase client ───────────────────────────────────────────
const supabase = createClient(
  process.env.https://fofsepdedipfmofabbpe.supabase.co,
  process.env.sb_publishable_6fKg6quDB7BIFrDnGUdijg_CepgGU7t
);

const BUCKET        = process.env.SUPABASE_BUCKET || 'tempshare-files';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_MB  || '100') * 1024 * 1024;
const EXPIRY_HOURS  = parseInt(process.env.EXPIRY_HOURS || '24');
const DELETE_ON_DL  = process.env.DELETE_ON_DOWNLOAD === 'true';

// ── Allowed MIME types ────────────────────────────────────────
const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip', 'application/x-zip-compressed',
  'application/x-rar-compressed', 'application/x-7z-compressed',
  'application/gzip', 'application/x-tar',
  'text/plain', 'text/html', 'text/css', 'text/javascript',
  'application/json', 'application/xml',
]);

// ── In-memory metadata store ──────────────────────────────────
const fileStore = {};

// ── Multer: memory storage (buffer goes to Supabase) ─────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type "${file.mimetype}" is not allowed.`));
    }
  }
});

// ── Helpers ───────────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1024 ** 2)  return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3)  return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}

async function deleteFile(id) {
  const meta = fileStore[id];
  if (!meta) return;
  const { error } = await supabase.storage.from(BUCKET).remove([meta.storedName]);
  if (error) console.error('[SUPABASE DELETE ERROR]', error.message);
  delete fileStore[id];
  console.log('[DELETED]', id, meta.originalName);
}

async function cleanExpiredFiles() {
  const now = Date.now();
  let count = 0;
  for (const id of Object.keys(fileStore)) {
    if (fileStore[id].expiresAt <= now) {
      await deleteFile(id);
      count++;
    }
  }
  console.log('[CRON] Cleaned', count, 'expired file(s).');
}

// ============================================================
// POST /api/upload
// ============================================================
router.post('/api/upload', upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files were uploaded.' });
  }

  const now = Date.now();
  const results = [];

  for (const file of req.files) {
    const id         = uuidv4();
    const ext        = path.extname(file.originalname) || '';
    const storedName = id + ext;
    const expiresAt  = now + EXPIRY_HOURS * 60 * 60 * 1000;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storedName, file.buffer, {
        contentType : file.mimetype,
        cacheControl: '3600',
        upsert      : false,
      });

    if (error) {
      console.error('[SUPABASE UPLOAD ERROR]', error.message);
      return res.status(500).json({ error: 'Failed to upload: ' + error.message });
    }

    fileStore[id] = {
      id, originalName: file.originalname, storedName,
      mimeType: file.mimetype, size: file.size,
      sizeHuman: formatSize(file.size),
      uploadedAt: now, expiresAt, downloads: 0,
    };

    results.push({
      id, name: file.originalname,
      size: file.size, sizeHuman: formatSize(file.size),
      expiresAt, downloadUrl: '/download/' + id,
    });

    console.log('[UPLOAD]', id, file.originalname, '→ Supabase');
  }

  return res.status(201).json({ files: results });
});

// ============================================================
// GET /api/info/:id
// ============================================================
router.get('/api/info/:id', (req, res) => {
  const meta = fileStore[req.params.id];
  if (!meta) return res.status(404).json({ error: 'File not found or has expired.' });
  if (meta.expiresAt <= Date.now()) {
    deleteFile(req.params.id);
    return res.status(410).json({ error: 'This file has expired.' });
  }
  return res.json({
    id: meta.id, name: meta.originalName, mimeType: meta.mimeType,
    size: meta.size, sizeHuman: meta.sizeHuman,
    uploadedAt: meta.uploadedAt, expiresAt: meta.expiresAt,
    downloads: meta.downloads, deleteOnDl: DELETE_ON_DL,
  });
});

// ============================================================
// GET /download/:id — Stream from Supabase
// ============================================================
router.get('/download/:id', async (req, res) => {
  const { id } = req.params;
  const meta   = fileStore[id];
  if (!meta) return res.status(404).send('File not found or has expired.');
  if (meta.expiresAt <= Date.now()) {
    await deleteFile(id);
    return res.status(410).send('This file has expired.');
  }

  const { data, error } = await supabase.storage.from(BUCKET).download(meta.storedName);
  if (error || !data) {
    console.error('[DOWNLOAD ERROR]', error?.message);
    return res.status(500).send('Could not retrieve file.');
  }

  meta.downloads += 1;
  console.log('[DOWNLOAD]', id, meta.originalName, '(' + meta.downloads + 'x)');

  const buffer = Buffer.from(await data.arrayBuffer());
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(meta.originalName) + '"');
  res.setHeader('Content-Type', meta.mimeType);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);

  if (DELETE_ON_DL) await deleteFile(id);
});

// ============================================================
// DELETE /api/delete/:id
// ============================================================
router.delete('/api/delete/:id', async (req, res) => {
  if (!fileStore[req.params.id]) return res.status(404).json({ error: 'File not found.' });
  await deleteFile(req.params.id);
  return res.json({ success: true });
});

// ============================================================
// GET /api/stats
// ============================================================
router.get('/api/stats', (req, res) => {
  const files = Object.values(fileStore);
  res.json({
    activeFiles: files.length,
    totalSize  : formatSize(files.reduce((s, f) => s + f.size, 0)),
    expiryHours: EXPIRY_HOURS,
    maxFileMB  : MAX_FILE_SIZE / 1024 / 1024,
  });
});

module.exports = { router, cleanExpiredFiles };
    
