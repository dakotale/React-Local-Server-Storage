require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const os        = require('os');
const { Readable } = require('stream');
const archiver  = require('archiver');
const Anthropic = require('@anthropic-ai/sdk');

// sharp is optional — thumbnails are generated when available, otherwise cards
// fall back to serving the full image (which still works, just slower).
let sharp;
try { sharp = require('sharp'); } catch { sharp = null; }

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Storage paths ─────────────────────────────────────────────────────────────
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const META_PATH    = path.join(__dirname, 'metadata.json');
const FOLDERS_PATH = path.join(__dirname, 'folders.json');

if (!fs.existsSync(UPLOADS_DIR))  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(META_PATH))    fs.writeFileSync(META_PATH,    '{}');
if (!fs.existsSync(FOLDERS_PATH)) fs.writeFileSync(FOLDERS_PATH, '[]');

// ── JSON store helpers ────────────────────────────────────────────────────────
// Cached in memory after first read — every route was previously doing a
// synchronous full-file read on every request (including plain GETs), which
// blocks Node's single event loop and gets slower as metadata.json grows.
// Writes still go straight to disk, so the file on disk stays authoritative.
let metaCache = null;
const readMeta = () => {
  if (metaCache === null) {
    try { metaCache = JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch { metaCache = {}; }
  }
  return metaCache;
};
const writeMeta = d => { metaCache = d; fs.writeFileSync(META_PATH, JSON.stringify(d, null, 2)); };

let foldersCache = null;
const readFolders = () => {
  if (foldersCache === null) {
    try { foldersCache = JSON.parse(fs.readFileSync(FOLDERS_PATH, 'utf8')); } catch { foldersCache = []; }
  }
  return foldersCache;
};
const writeFolders = l => { foldersCache = l; fs.writeFileSync(FOLDERS_PATH, JSON.stringify(l)); };

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1048576)    return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function getLocalIPs() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
}

// Prevent path traversal — only accept 32-char hex IDs
const validId = id => /^[a-f0-9]{32}$/.test(id);

// Normalizes a "folder" path: trims each "/"-separated segment, drops empty
// ones (collapsing accidental "//"), and caps overall length. Segments (not
// just the whole string) matter now that folders can nest.
function normalizeFolderPath(raw) {
  return String(raw || '')
    .split('/')
    .map(s => s.trim())
    .filter(Boolean)
    .join('/')
    .slice(0, 200);
}

function categoryOf(mimeType, name) {
  const mime = (mimeType || '').toLowerCase();
  const ext  = (name || '').split('.').pop().toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/')) return 'text';
  const code = ['js','ts','py','java','c','cpp','h','cs','php','rb','go','rs','swift',
                'sh','bash','json','xml','yaml','yml','toml','md','html','css','sql'];
  if (code.includes(ext)) return 'text';
  return 'other';
}

// Extension guesses for URL uploads whose path has none (e.g. a CDN URL
// ending in an opaque id) — best-effort, not exhaustive.
const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'application/pdf': '.pdf',
  'text/plain': '.txt', 'text/html': '.html', 'application/json': '.json',
  'video/mp4': '.mp4', 'audio/mpeg': '.mp3'
};

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const id  = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
    cb(null, id + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── Anthropic ─────────────────────────────────────────────────────────────────
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── File routes ───────────────────────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  const meta = readMeta();
  const totalSize = Object.values(meta).reduce((s, f) => s + (f.size || 0), 0);
  res.json({ ips: getLocalIPs(), port: PORT, fileCount: Object.keys(meta).length, totalSize, totalSizeFormatted: formatSize(totalSize) });
});

app.get('/api/storage', (req, res) => {
  const files = Object.values(readMeta());
  const totalSize = files.reduce((s, f) => s + (f.size || 0), 0);

  const byCategory = {};
  const byFolder   = {};
  files.forEach(f => {
    const cat = categoryOf(f.mimeType, f.name);
    byCategory[cat] = (byCategory[cat] || 0) + (f.size || 0);
    const folderKey = f.folder || 'No folder';
    byFolder[folderKey] = (byFolder[folderKey] || 0) + (f.size || 0);
  });

  let disk = null;
  try {
    // statfs isn't guaranteed on every platform/Node version — degrade to
    // just the app's own usage numbers if it throws.
    const stats = fs.statfsSync(UPLOADS_DIR);
    const total = stats.blocks * stats.bsize;
    const free  = stats.bavail * stats.bsize;
    disk = { total, free, used: total - free, totalFormatted: formatSize(total), freeFormatted: formatSize(free), usedFormatted: formatSize(total - free) };
  } catch { /* disk stays null */ }

  res.json({
    fileCount: files.length,
    totalSize, totalSizeFormatted: formatSize(totalSize),
    byCategory: Object.entries(byCategory)
      .map(([category, size]) => ({ category, size, sizeFormatted: formatSize(size) }))
      .sort((a, b) => b.size - a.size),
    byFolder: Object.entries(byFolder)
      .map(([folder, size]) => ({ folder, size, sizeFormatted: formatSize(size) }))
      .sort((a, b) => b.size - a.size),
    disk
  });
});

app.get('/api/files', (req, res) => {
  const meta  = readMeta();
  const files = Object.entries(meta)
    .map(([id, info]) => ({ id, ...info, sizeFormatted: formatSize(info.size || 0), tags: info.tags || [], folder: info.folder || null }))
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(files);
});

app.post('/api/upload', upload.array('files', 20), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files received' });
  const meta     = readMeta();
  const uploaded = await Promise.all(req.files.map(async f => {
    const id     = path.parse(f.filename).name;
    const folder = normalizeFolderPath(req.body.folder) || null;
    const info   = { name: f.originalname, size: f.size, sizeFormatted: formatSize(f.size), mimeType: f.mimetype, uploadedAt: new Date().toISOString(), storedName: f.filename, tags: [], folder };

    // Generate a small JPEG thumbnail for images so the grid loads fast.
    // Non-fatal — if sharp isn't installed or the image is unreadable the card
    // falls back to /preview (the full file) automatically.
    if (sharp && f.mimetype.startsWith('image/')) {
      try {
        await sharp(path.join(UPLOADS_DIR, f.filename))
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toFile(path.join(UPLOADS_DIR, id + '_thumb.jpg'));
        info.hasThumb = true;
      } catch { /* leave hasThumb undefined */ }
    }

    meta[id] = info;
    return { id, ...info };
  }));
  writeMeta(meta);
  res.json({ success: true, files: uploaded });
});

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // matches the multer limit above

app.post('/api/upload-url', async (req, res) => {
  let parsed;
  try { parsed = new URL((req.body.url || '').trim()); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return res.status(400).json({ error: 'Only http/https URLs are supported' });

  let response;
  try {
    response = await fetch(parsed.href, { redirect: 'follow' });
  } catch (err) {
    return res.status(400).json({ error: 'Could not fetch URL: ' + err.message });
  }
  if (!response.ok || !response.body) return res.status(400).json({ error: 'URL returned HTTP ' + response.status });

  const lenHeader = response.headers.get('content-length');
  if (lenHeader && Number(lenHeader) > MAX_UPLOAD_BYTES)
    return res.status(413).json({ error: 'File exceeds 500 MB limit' });

  const disposition = response.headers.get('content-disposition') || '';
  const dispMatch   = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const mimeType    = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  let originalName  = dispMatch ? decodeURIComponent(dispMatch[1]) : (path.basename(parsed.pathname) || 'download');
  if (!path.extname(originalName) && MIME_EXT[mimeType]) originalName += MIME_EXT[mimeType];

  const id       = crypto.randomBytes(16).toString('hex');
  const ext      = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const storedName = id + ext;
  const destPath   = path.join(UPLOADS_DIR, storedName);

  const nodeStream = Readable.fromWeb(response.body);
  const fileStream = fs.createWriteStream(destPath);
  let bytesWritten = 0;
  let tooBig = false;
  try {
    for await (const chunk of nodeStream) {
      bytesWritten += chunk.length;
      if (bytesWritten > MAX_UPLOAD_BYTES) { tooBig = true; break; }
      if (!fileStream.write(chunk)) await new Promise(r => fileStream.once('drain', r));
    }
  } catch (err) {
    fileStream.destroy();
    try { fs.unlinkSync(destPath); } catch {}
    return res.status(500).json({ error: 'Download failed: ' + err.message });
  }
  fileStream.end();
  await new Promise(r => fileStream.once('finish', r));

  if (tooBig) {
    try { fs.unlinkSync(destPath); } catch {}
    return res.status(413).json({ error: 'File exceeds 500 MB limit' });
  }

  const folder = normalizeFolderPath(req.body.folder) || null;
  const info = {
    name: originalName, size: bytesWritten, sizeFormatted: formatSize(bytesWritten),
    mimeType, uploadedAt: new Date().toISOString(), storedName, tags: [], folder
  };

  if (sharp && mimeType.startsWith('image/')) {
    try {
      await sharp(destPath).resize(400, 400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(path.join(UPLOADS_DIR, id + '_thumb.jpg'));
      info.hasThumb = true;
    } catch { /* leave hasThumb undefined */ }
  }

  const meta = readMeta();
  meta[id] = info;
  writeMeta(meta);
  res.json({ success: true, files: [{ id, ...info }] });
});

// Serves a small thumbnail for image cards; falls back to the full file if no
// thumbnail exists (e.g. uploaded before sharp was installed).
app.get('/api/files/:id/thumb', (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const info = readMeta()[req.params.id];
  if (!info) return res.status(404).json({ error: 'Not found' });
  const thumbPath = path.join(UPLOADS_DIR, req.params.id + '_thumb.jpg');
  if (fs.existsSync(thumbPath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    return res.sendFile(thumbPath);
  }
  // Fallback: serve the full image inline
  const fp = path.join(UPLOADS_DIR, info.storedName);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing' });
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Content-Type', info.mimeType || 'application/octet-stream');
  res.sendFile(fp);
});

app.get('/api/files/:id/preview', (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const info = readMeta()[req.params.id];
  if (!info) return res.status(404).json({ error: 'Not found' });
  const fp = path.join(UPLOADS_DIR, info.storedName);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing' });
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Content-Type', info.mimeType || 'application/octet-stream');
  res.sendFile(fp);
});

app.get('/api/files/:id/download', (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const info = readMeta()[req.params.id];
  if (!info) return res.status(404).json({ error: 'Not found' });
  const fp = path.join(UPLOADS_DIR, info.storedName);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing' });
  res.download(fp, info.name);
});

app.patch('/api/files/:id', (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const meta = readMeta();
  const info = meta[req.params.id];
  if (!info) return res.status(404).json({ error: 'Not found' });
  if (req.body.tags !== undefined) {
    if (!Array.isArray(req.body.tags)) return res.status(400).json({ error: 'tags must be an array' });
    info.tags = req.body.tags.map(t => String(t).trim().toLowerCase().slice(0, 30)).filter(Boolean);
  }
  if (req.body.folder !== undefined) {
    info.folder = normalizeFolderPath(req.body.folder) || null;
  }
  if (req.body.name !== undefined) {
    const newName = String(req.body.name || '').trim().slice(0, 255);
    if (!newName) return res.status(400).json({ error: 'name cannot be empty' });
    info.name = newName;
  }
  writeMeta(meta);
  res.json({ success: true, file: { id: req.params.id, ...info, sizeFormatted: formatSize(info.size || 0) } });
});

app.delete('/api/files/:id', (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const meta = readMeta();
  const info = meta[req.params.id];
  if (!info) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(path.join(UPLOADS_DIR, info.storedName)); } catch {}
  try { fs.unlinkSync(path.join(UPLOADS_DIR, req.params.id + '_thumb.jpg')); } catch {}
  delete meta[req.params.id];
  writeMeta(meta);
  res.json({ success: true });
});

// ── Bulk routes ───────────────────────────────────────────────────────────────
// Live under /api/bulk/* (not /api/files/:id/*) so they can't collide with the
// single-file routes above — an id-shaped route registered first would always
// win the match and the bulk request would 400 as an "invalid id".
function bulkIds(body) {
  return Array.isArray(body.ids) ? body.ids.filter(validId) : [];
}

app.post('/api/bulk/delete', (req, res) => {
  const ids = bulkIds(req.body);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  const meta = readMeta();
  let deleted = 0;
  ids.forEach(id => {
    const info = meta[id];
    if (!info) return;
    try { fs.unlinkSync(path.join(UPLOADS_DIR, info.storedName)); } catch {}
    try { fs.unlinkSync(path.join(UPLOADS_DIR, id + '_thumb.jpg')); } catch {}
    delete meta[id];
    deleted++;
  });
  writeMeta(meta);
  res.json({ success: true, deleted });
});

// Additive tag (not the single-file PATCH's "replace tags") since a bulk
// selection spans files that each already have their own, different tags.
app.patch('/api/bulk/update', (req, res) => {
  const ids = bulkIds(req.body);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  const addTag = typeof req.body.addTag === 'string' ? req.body.addTag.trim().toLowerCase().slice(0, 30) : null;
  const folderProvided = req.body.folder !== undefined;
  const folder = folderProvided ? (normalizeFolderPath(req.body.folder) || null) : null;

  const meta = readMeta();
  let updated = 0;
  ids.forEach(id => {
    const info = meta[id];
    if (!info) return;
    if (addTag) {
      info.tags = info.tags || [];
      if (info.tags.indexOf(addTag) === -1) info.tags.push(addTag);
    }
    if (folderProvided) info.folder = folder;
    updated++;
  });
  writeMeta(meta);
  res.json({ success: true, updated });
});

app.get('/api/bulk/download', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(validId);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  const meta = readMeta();

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { if (!res.headersSent) res.status(500).json({ error: err.message }); else res.end(); });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="files.zip"');
  archive.pipe(res);

  const usedNames = new Set();
  ids.forEach(id => {
    const info = meta[id];
    if (!info) return;
    const fp = path.join(UPLOADS_DIR, info.storedName);
    if (!fs.existsSync(fp)) return;
    let name = info.name;
    if (usedNames.has(name)) {
      const ext = path.extname(name);
      name = path.basename(name, ext) + ' (' + id.slice(0, 6) + ')' + ext;
    }
    usedNames.add(name);
    archive.file(fp, { name });
  });

  archive.finalize();
});

// ── Folder routes ─────────────────────────────────────────────────────────────
app.get('/api/folders', (req, res) => {
  const fromFiles = Object.values(readMeta()).map(f => f.folder).filter(Boolean);
  res.json([...new Set([...readFolders(), ...fromFiles])].sort());
});

app.post('/api/folders', (req, res) => {
  // "name" is a full path like "Work/Invoices" for nested folders — the
  // client composes it from currentFolder + the typed name, so a folder
  // created while inside "Work" becomes "Work/<new>" automatically.
  const name = normalizeFolderPath(req.body.name);
  if (!name) return res.status(400).json({ error: 'name required' });
  const list = readFolders();
  if (!list.includes(name)) { list.push(name); writeFolders(list); }
  res.json({ success: true, name });
});

// :name may contain an encoded "/" (e.g. "Work%2FInvoices") — Express
// decodes the captured param, so req.params.name comes back with the real
// "/" restored. Deleting a folder cascades to its subfolders and clears
// `folder` on every file under that path (files themselves are untouched,
// they just fall back to "no folder").
app.delete('/api/folders/:name', (req, res) => {
  const name = req.params.name;
  const prefix = name + '/';
  writeFolders(readFolders().filter(f => f !== name && !f.startsWith(prefix)));
  const meta = readMeta();
  Object.values(meta).forEach(f => {
    if (f.folder === name || (f.folder && f.folder.startsWith(prefix))) f.folder = null;
  });
  writeMeta(meta);
  res.json({ success: true });
});

// ── Chat route ────────────────────────────────────────────────────────────────
// Streams Claude responses as Server-Sent Events so text appears word-by-word.
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: 'messages array required' });
  if (!anthropic)
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set in .env' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');

  try {
    const stream = anthropic.messages.stream({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system: [{
        type: 'text',
        text: 'You are a helpful AI assistant embedded in a personal cloud storage app. Be concise and friendly.',
        cache_control: { type: 'ephemeral' }  // cache the static system prompt to save tokens
      }],
      messages
    });
    for await (const event of stream) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║        CloudStorage Server Ready         ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n  Local    ➜  http://localhost:${PORT}`);
  getLocalIPs().forEach(ip => console.log(`  Network  ➜  http://${ip}:${PORT}`));
  if (!anthropic) console.log('\n  ⚠  Chat disabled — add ANTHROPIC_API_KEY to .env');
  console.log('\n  Press Ctrl+C to stop\n');
});
