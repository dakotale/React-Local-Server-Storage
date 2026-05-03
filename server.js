require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const os        = require('os');
const Anthropic = require('@anthropic-ai/sdk');

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
const readMeta     = () => { try { return JSON.parse(fs.readFileSync(META_PATH,    'utf8')); } catch { return {}; } };
const writeMeta    = d  => fs.writeFileSync(META_PATH, JSON.stringify(d, null, 2));
const readFolders  = () => { try { return JSON.parse(fs.readFileSync(FOLDERS_PATH, 'utf8')); } catch { return []; } };
const writeFolders = l  => fs.writeFileSync(FOLDERS_PATH, JSON.stringify(l));

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

app.get('/api/files', (req, res) => {
  const meta  = readMeta();
  const files = Object.entries(meta)
    .map(([id, info]) => ({ id, ...info, sizeFormatted: formatSize(info.size || 0), tags: info.tags || [], folder: info.folder || null }))
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(files);
});

app.post('/api/upload', upload.array('files', 20), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files received' });
  const meta     = readMeta();
  const uploaded = req.files.map(f => {
    const id     = path.parse(f.filename).name;
    const folder = (req.body.folder || '').trim().slice(0, 60) || null;
    const info   = { name: f.originalname, size: f.size, sizeFormatted: formatSize(f.size), mimeType: f.mimetype, uploadedAt: new Date().toISOString(), storedName: f.filename, tags: [], folder };
    meta[id] = info;
    return { id, ...info };
  });
  writeMeta(meta);
  res.json({ success: true, files: uploaded });
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
    info.folder = String(req.body.folder || '').trim().slice(0, 60) || null;
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
  delete meta[req.params.id];
  writeMeta(meta);
  res.json({ success: true });
});

// ── Folder routes ─────────────────────────────────────────────────────────────
app.get('/api/folders', (req, res) => {
  const fromFiles = Object.values(readMeta()).map(f => f.folder).filter(Boolean);
  res.json([...new Set([...readFolders(), ...fromFiles])].sort());
});

app.post('/api/folders', (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name required' });
  const list = readFolders();
  if (!list.includes(name)) { list.push(name); writeFolders(list); }
  res.json({ success: true, name });
});

app.delete('/api/folders/:name', (req, res) => {
  writeFolders(readFolders().filter(f => f !== req.params.name));
  const meta = readMeta();
  Object.values(meta).forEach(f => { if (f.folder === req.params.name) f.folder = null; });
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
