// ============================================================
// routes.js — All API routes for TempShare
// ============================================================

const express = require('express');
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const fs      = require('fs');

const router = express.Router();

// ── Config ────────────────────────────────────────────────────
const UPLOADS_DIR    = path.join(__dirname, 'uploads');
const MAX_FILE_SIZE  = parseInt(process.env.MAX_FILE_MB  || '100') * 1024 * 1024; // 100 MB default
const EXPIRY_HOURS   = parseInt(process.env.EXPIRY_HOURS || '24');                // 24 h default
const DELETE_ON_DL   = process.env.DELETE_ON_DOWNLOAD === 'true';                 // false by default

// ── Allowed MIME types (extend as needed) ─────────────────────
const ALLOWED_TYPES = new Set([
  // Images
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  // Video
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
  // Audio
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Archives
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/gzip',
  'application/x-tar',
  // Text / Code
  'text/plain', 'text/html', 'text/css', 'text/javascript',
  'application/json', 'application/xml',
]);

// ── In-memory metadata store ──────────────────────────────────
// Shape: { [id]: { id, originalName, storedName, mimeType, size, uploadedAt, expiresAt, downloads } }
const fileStore = {};

// ── Multer storage config ─────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type "${file.mimetype}" is not allowed.`));
    }
  }
});

// ── Helper: human-readable size ───────────────────────────────
function formatSize(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 ** 2)   return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)   return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// ── Helper: delete file + metadata ───────────────────────────
function deleteFile(id) {
  const meta = fileStore[id];
  if (!meta) return;
  const filePath = path.join(UPLOADS_DIR, meta.storedName);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) { console.error('[DELETE]', e.message); }
  }
  delete fileStore[id];
  console.log(`[DELETED] ${id} — ${meta.originalName}`);
}

// ── Export: cleanup called by cron ────────────────────────────
function cleanExpiredFiles() {
  const now = Date.now();
  let count = 0;
  for (const id of Object.keys(fileStore)) {
    if (fileStore[id].expiresAt <= now) {
      deleteFile(id);
      count++;
    }
  }
  console.log(`[CRON] Cleaned ${count} expired file(s).`);
}

// ============================================================
// POST /api/upload  — Upload one or more files
// ============================================================
router.post('/api/upload', upload.array('files', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files were uploaded.' });
  }

  const now = Date.now();
  const results = req.files.map(file => {
    const id = path.parse(file.filename).name; // UUID already in filename
    const expiresAt = now + EXPIRY_HOURS * 60 * 60 * 1000;

    fileStore[id] = {
      id,
      originalName: file.originalname,
      storedName  : file.filename,
      mimeType    : file.mimetype,
      size        : file.size,
      sizeHuman   : formatSize(file.size),
      uploadedAt  : now,
      expiresAt,
      downloads   : 0
    };

    return {
      id,
      name    : file.originalname,
      size    : file.size,
      sizeHuman: formatSize(file.size),
      expiresAt,
      downloadUrl: `/download/${id}`
    };
  });

  console.log(`[UPLOAD] ${results.length} file(s) — IDs: ${results.map(r => r.id).join(', ')}`);
  return res.status(201).json({ files: results });
});

// ============================================================
// GET /api/info/:id  — File metadata (for download page)
// ============================================================
router.get('/api/info/:id', (req, res) => {
  const { id } = req.params;
  const meta = fileStore[id];

  if (!meta) {
    return res.status(404).json({ error: 'File not found or has expired.' });
  }

  if (meta.expiresAt <= Date.now()) {
    deleteFile(id);
    return res.status(410).json({ error: 'This file has expired and been deleted.' });
  }

  return res.json({
    id          : meta.id,
    name        : meta.originalName,
    mimeType    : meta.mimeType,
    size        : meta.size,
    sizeHuman   : meta.sizeHuman,
    uploadedAt  : meta.uploadedAt,
    expiresAt   : meta.expiresAt,
    downloads   : meta.downloads,
    deleteOnDl  : DELETE_ON_DL
  });
});

// ============================================================
// GET /download/:id  — Stream file to client
// ============================================================
router.get('/download/:id', (req, res) => {
  const { id } = req.params;
  const meta = fileStore[id];

  if (!meta) {
    return res.status(404).send('File not found or has expired.');
  }

  if (meta.expiresAt <= Date.now()) {
    deleteFile(id);
    return res.status(410).send('This file has expired.');
  }

  const filePath = path.join(UPLOADS_DIR, meta.storedName);
  if (!fs.existsSync(filePath)) {
    delete fileStore[id];
    return res.status(404).send('File data missing on server.');
  }

  // Increment download counter
  meta.downloads += 1;

  // Stream the file — res.download() handles Content-Disposition + MIME
  res.download(filePath, meta.originalName, err => {
    if (err) {
      console.error('[DOWNLOAD ERROR]', err.message);
    } else {
      console.log(`[DOWNLOAD] ${id} — ${meta.originalName} (${meta.downloads}x)`);
      // Delete after first download if configured
      if (DELETE_ON_DL) {
        deleteFile(id);
      }
    }
  });
});

// ============================================================
// DELETE /api/delete/:id  — Manual delete (optional)
// ============================================================
router.delete('/api/delete/:id', (req, res) => {
  const { id } = req.params;
  if (!fileStore[id]) {
    return res.status(404).json({ error: 'File not found.' });
  }
  deleteFile(id);
  return res.json({ success: true, message: 'File deleted.' });
});

// ============================================================
// GET /api/stats  — Public stats (no sensitive data)
// ============================================================
router.get('/api/stats', (req, res) => {
  const files = Object.values(fileStore);
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  res.json({
    activeFiles: files.length,
    totalSize  : formatSize(totalSize),
    expiryHours: EXPIRY_HOURS,
    maxFileMB  : MAX_FILE_SIZE / 1024 / 1024
  });
});

module.exports = { router, cleanExpiredFiles };

