/* ============================================================
   upload.js — TempShare client-side logic
   ============================================================ */

// ── Router: decide which page to show ─────────────────────────
const path = window.location.pathname;

if (path.startsWith('/download/')) {
  const fileId = path.split('/download/')[1];
  showDownloadPage(fileId);
} else {
  showUploadPage();
}

// ============================================================
// UPLOAD PAGE
// ============================================================
function showUploadPage() {
  document.getElementById('page-upload').classList.remove('hidden');
  document.getElementById('page-download').classList.add('hidden');

  initStats();
  initDropZone();
}

// ── Stats badge ────────────────────────────────────────────────
async function initStats() {
  try {
    const res  = await fetch('/api/stats');
    const data = await res.json();
    const badge = document.getElementById('stats-badge');
    const text  = document.getElementById('stats-text');
    text.textContent = `${data.activeFiles} active · max ${data.maxFileMB}MB`;
    badge.classList.remove('hidden');
  } catch (_) { /* no stats, no problem */ }
}

// ── Drop zone & file picker ────────────────────────────────────
function initDropZone() {
  const zone       = document.getElementById('drop-zone');
  const fileInput  = document.getElementById('file-input');
  const browseBtn  = document.getElementById('browse-btn');
  const idle       = document.getElementById('drop-idle');
  const activeEl   = document.getElementById('drop-active');

  let selectedFiles = [];

  // Click to browse
  browseBtn.addEventListener('click', e => {
    e.stopPropagation();
    fileInput.click();
  });
  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });

  fileInput.addEventListener('change', e => {
    addFiles([...e.target.files]);
    fileInput.value = ''; // reset so same file can re-trigger
  });

  // Drag events
  zone.addEventListener('dragover',  e => { e.preventDefault(); setDragging(true); });
  zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) setDragging(false); });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
  });

  // Global drag-over-window highlight
  document.addEventListener('dragenter', e => { e.preventDefault(); setDragging(true); });

  function setDragging(state) {
    zone.classList.toggle('dragging', state);
    idle.classList.toggle('hidden', state);
    activeEl.classList.toggle('hidden', !state);
  }

  function addFiles(newFiles) {
    const MAX = 10, MAX_SIZE = 100 * 1024 * 1024;
    for (const file of newFiles) {
      if (selectedFiles.length >= MAX) {
        showToast('⚠️ Max 10 files at once', 'warn'); break;
      }
      if (file.size > MAX_SIZE) {
        showToast(`⚠️ "${file.name}" exceeds 100 MB`, 'warn'); continue;
      }
      if (selectedFiles.some(f => f.name === file.name && f.size === file.size)) continue;
      selectedFiles.push(file);
    }
    renderFileList();
  }

  function removeFile(idx) {
    selectedFiles.splice(idx, 1);
    renderFileList();
  }

  function renderFileList() {
    const section   = document.getElementById('file-list-section');
    const list      = document.getElementById('file-list');
    const uploadBtn = document.getElementById('upload-btn');

    if (selectedFiles.length === 0) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');

    list.innerHTML = selectedFiles.map((f, i) => `
      <li class="file-item">
        <span class="file-item-icon">${fileIcon(f)}</span>
        <div class="file-item-info">
          <div class="file-item-name" title="${esc(f.name)}">${esc(f.name)}</div>
          <div class="file-item-size">${formatBytes(f.size)}</div>
        </div>
        <button class="remove-file-btn" data-idx="${i}" aria-label="Remove ${esc(f.name)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </li>
    `).join('');

    list.querySelectorAll('.remove-file-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        removeFile(+btn.dataset.idx);
      });
    });

    document.getElementById('clear-files-btn').onclick = () => {
      selectedFiles = [];
      renderFileList();
    };

    uploadBtn.onclick = () => startUpload(selectedFiles);
  }

  // ── Upload ─────────────────────────────────────────────────
  function startUpload(files) {
    if (!files.length) return;

    // Hide pre-upload UI
    document.getElementById('file-list-section').classList.add('hidden');
    document.getElementById('error-section').classList.add('hidden');
    document.getElementById('result-section').classList.add('hidden');

    const progressSection = document.getElementById('progress-section');
    const progressBar     = document.getElementById('progress-bar');
    const progressPct     = document.getElementById('progress-pct');
    const progressLabel   = document.getElementById('progress-label');

    progressSection.classList.remove('hidden');
    progressBar.style.width = '0%';
    progressPct.textContent = '0%';
    progressLabel.textContent = `Uploading ${files.length} file(s)…`;

    const formData = new FormData();
    files.forEach(f => formData.append('files', f));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressBar.style.width = `${pct}%`;
        progressPct.textContent = `${pct}%`;
        progressLabel.textContent = `${formatBytes(e.loaded)} / ${formatBytes(e.total)}`;
      }
    };

    xhr.onload = () => {
      progressSection.classList.add('hidden');
      if (xhr.status === 201) {
        const { files: uploadedFiles } = JSON.parse(xhr.responseText);
        selectedFiles = [];
        showResults(uploadedFiles);
      } else {
        let msg = 'Upload failed. Please try again.';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
        showError(msg);
      }
    };

    xhr.onerror = () => {
      progressSection.classList.add('hidden');
      showError('Network error. Check your connection and retry.');
    };

    xhr.send(formData);
  }
}

// ── Show upload results ────────────────────────────────────────
function showResults(files) {
  const section = document.getElementById('result-section');

  const successHeader = `
    <div class="glass-card p-5 mb-4 border border-green-500/20">
      <div class="flex items-center gap-3 mb-1">
        <span class="text-2xl">🎉</span>
        <span class="text-green-300 font-semibold">
          ${files.length} file${files.length > 1 ? 's' : ''} uploaded successfully!
        </span>
      </div>
      <p class="text-white/40 text-sm ml-9">Links expire in 24 hours.</p>
    </div>
  `;

  const fileCards = files.map(f => {
    const fullUrl = `${window.location.origin}/download/${f.id}`;
    return `
      <div class="result-card">
        <div class="flex items-center gap-3 mb-2">
          <span class="text-xl">${mimeIcon(f.name)}</span>
          <div class="flex-1 min-w-0">
            <p class="text-white/90 font-medium text-sm truncate">${esc(f.name)}</p>
            <p class="text-white/40 text-xs">${f.sizeHuman}</p>
          </div>
        </div>
        <div class="result-link-row">
          <span class="result-link" title="${esc(fullUrl)}">${esc(fullUrl)}</span>
          <button class="copy-btn" data-url="${esc(fullUrl)}">Copy</button>
        </div>
      </div>
    `;
  }).join('');

  const newUploadBtn = `
    <div class="text-center mt-5">
      <button id="new-upload-btn" class="text-white/40 hover:text-white/70 text-sm transition-colors">
        + Upload more files
      </button>
    </div>
  `;

  section.innerHTML = successHeader + fileCards + newUploadBtn;
  section.classList.remove('hidden');

  // Wire copy buttons
  section.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.url).then(() => {
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        showToast('📋 Link copied!');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2500);
      }).catch(() => showToast('⚠️ Could not copy', 'warn'));
    });
  });

  // Reset button
  document.getElementById('new-upload-btn')?.addEventListener('click', () => {
    section.classList.add('hidden');
    document.getElementById('drop-zone').scrollIntoView({ behavior: 'smooth' });
  });

  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Show error ─────────────────────────────────────────────────
function showError(msg) {
  document.getElementById('error-msg').textContent = msg;
  document.getElementById('error-section').classList.remove('hidden');
  document.getElementById('file-list-section').classList.remove('hidden');
}

// ============================================================
// DOWNLOAD PAGE
// ============================================================
async function showDownloadPage(id) {
  document.getElementById('page-upload').classList.add('hidden');
  document.getElementById('page-download').classList.remove('hidden');

  const loading  = document.getElementById('dl-loading');
  const card     = document.getElementById('dl-card');
  const notFound = document.getElementById('dl-not-found');

  try {
    const res  = await fetch(`/api/info/${id}`);
    loading.classList.add('hidden');

    if (res.status === 404 || res.status === 410) {
      notFound.classList.remove('hidden');
      return;
    }

    if (!res.ok) throw new Error('Server error');

    const meta = await res.json();

    // Populate card
    document.getElementById('dl-icon').textContent     = mimeIcon(meta.name);
    document.getElementById('dl-filename').textContent = meta.name;
    document.getElementById('dl-size').textContent     = meta.sizeHuman;
    document.getElementById('dl-mime').textContent     = meta.mimeType;
    document.getElementById('dl-count').textContent    = meta.downloads;
    document.getElementById('dl-expiry').textContent   = timeUntil(meta.expiresAt);
    document.getElementById('dl-btn').href             = `/download/${id}`;

    card.classList.remove('hidden');

    // Update expiry countdown every minute
    setInterval(() => {
      const el = document.getElementById('dl-expiry');
      if (el) el.textContent = timeUntil(meta.expiresAt);
    }, 60_000);

  } catch (err) {
    loading.classList.add('hidden');
    notFound.classList.remove('hidden');
  }
}

// ============================================================
// HELPERS
// ============================================================

function formatBytes(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 ** 2)   return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)   return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fileIcon(file) {
  return mimeIcon(file.name, file.type);
}

function mimeIcon(name = '', mime = '') {
  const ext = name.split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','gif','webp','svg'].includes(ext) || mime.startsWith('image/')) return '🖼️';
  if (['mp4','mov','avi','webm','mkv'].includes(ext) || mime.startsWith('video/'))         return '🎬';
  if (['mp3','wav','ogg','flac','aac'].includes(ext) || mime.startsWith('audio/'))         return '🎵';
  if (['pdf'].includes(ext))                          return '📕';
  if (['doc','docx'].includes(ext))                   return '📝';
  if (['xls','xlsx'].includes(ext))                   return '📊';
  if (['ppt','pptx'].includes(ext))                   return '📊';
  if (['zip','rar','7z','tar','gz'].includes(ext))    return '🗜️';
  if (['js','ts','py','java','c','cpp','go','rs'].includes(ext)) return '💻';
  if (['json','xml','yaml','yml','toml'].includes(ext)) return '⚙️';
  if (['html','css'].includes(ext))                   return '🌐';
  if (['txt','md','csv'].includes(ext))               return '📄';
  return '📁';
}

function timeUntil(ts) {
  const diff = ts - Date.now();
  if (diff <= 0) return 'Expired';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0)  return `${h}h ${m}m`;
  if (m > 0)  return `${m} min`;
  return 'Less than a minute';
}

// ── Toast ──────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, _type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden', 'show');
  // Trigger reflow for CSS transition
  void toast.offsetWidth;
  toast.classList.add('show');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, 2800);
}

