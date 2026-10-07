'use strict';

require('dotenv').config();

const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { Readable } = require('stream');

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 18) {
  console.error('\n  ❌ Node ' + process.versions.node + ' is too old. Need Node 18+.\n');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

const RAPIDAPI_KEY      = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST     = process.env.RAPIDAPI_HOST;
const RAPIDAPI_ENDPOINT = process.env.RAPIDAPI_ENDPOINT;
const CORS_ORIGIN       = process.env.CORS_ORIGIN;

console.log('');
console.log('  Reels Downloader — backend');
console.log('  ------------------------------------------');
console.log('  Node:               ' + process.version);
console.log('  Port:               ' + PORT);
console.log('  RAPIDAPI_KEY:       ' + (RAPIDAPI_KEY ? 'SET' : '❌ MISSING'));
console.log('  RAPIDAPI_HOST:      ' + (RAPIDAPI_HOST || '❌ MISSING'));
console.log('  RAPIDAPI_ENDPOINT:  ' + (RAPIDAPI_ENDPOINT || '❌ MISSING'));
console.log('  ------------------------------------------');
console.log('');

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

if (CORS_ORIGIN) {
  const allowed = CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30,
  standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    success: false, error: 'RATE_LIMIT',
    message: 'Too many requests. Please try again later.'
  })
});

const REEL_RE = /^https?:\/\/(?:www\.)?instagram\.com\/reels?\/([A-Za-z0-9_-]+)/i;

function extractShortcode(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > 2048) return null;
  const m = t.match(REEL_RE);
  return m ? m[1] : null;
}

function qualityFromDimensions(w, h) {
  const base = Math.min(Number(w) || 0, Number(h) || 0);
  return base ? base + 'p' : 'Video';
}

function findMediaNode(obj, depth) {
  depth = depth || 0;
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (Array.isArray(obj.video_versions) && obj.video_versions.length) return obj;
  const wrappers = ['data', 'result', 'response', 'media', 'items', 'reel', 'post', 'contents'];
  for (const key of wrappers) {
    if (obj[key]) {
      const found = findMediaNode(obj[key], depth + 1);
      if (found) return found;
    }
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findMediaNode(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function pickThumbnail(media) {
  const c = (media && media.image_versions2 && Array.isArray(media.image_versions2.candidates))
    ? media.image_versions2.candidates : [];
  if (!c.length) return '';
  const sorted = c.filter(x => x && x.url).slice()
    .sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
  return sorted.length ? sorted[0].url : '';
}

function normaliseMedia(media, shortcode) {
  if (media.user && media.user.is_private === true) return { error: 'PRIVATE' };

  const raw = Array.isArray(media.video_versions) ? media.video_versions : [];
  if (!raw.length) return { error: 'NO_VIDEO' };

  const seenUrl = new Set(), seenRes = new Set();
  const videos = raw
    .filter(v => v && typeof v.url === 'string' && v.url.length)
    .map(v => ({
      width: Number(v.width) || 0,
      height: Number(v.height) || 0,
      quality: qualityFromDimensions(v.width, v.height),
      url: v.url
    }))
    .filter(v => {
      if (seenUrl.has(v.url)) return false;
      seenUrl.add(v.url);
      const key = v.width + 'x' + v.height;
      if (seenRes.has(key)) return false;
      seenRes.add(key);
      return true;
    })
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));

  if (!videos.length) return { error: 'NO_VIDEO' };

  return {
    shortcode: media.code || shortcode,
    username: (media.user && media.user.username) || 'unknown',
    fullName: (media.user && media.user.full_name) || '',
    thumbnail: pickThumbnail(media),
    hasAudio: media.has_audio !== false,
    videos
  };
}

function buildEndpoint(shortcode) {
  const canonical = 'https://www.instagram.com/reel/' + shortcode + '/';
  return RAPIDAPI_ENDPOINT
    .replace(/\{shortcode\}/g, encodeURIComponent(shortcode))
    .replace(/\{url\}/g, encodeURIComponent(canonical));
}

/* POST /api/download */
app.post('/api/download', apiLimiter, async (req, res) => {
  try {
    const rawUrl = (req.body || {}).url;
    console.log('[req] incoming:', JSON.stringify(rawUrl));

    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return res.status(400).json({ success: false, error: 'INVALID_URL',
        message: 'Please paste a valid Instagram Reel URL.' });
    }

    const shortcode = extractShortcode(rawUrl);
    if (!shortcode) {
      return res.status(400).json({ success: false, error: 'INVALID_URL',
        message: 'Please paste a valid Instagram Reel URL.' });
    }
    console.log('[req] shortcode:', shortcode);

    if (!RAPIDAPI_KEY || !RAPIDAPI_HOST || !RAPIDAPI_ENDPOINT) {
      return res.status(500).json({ success: false, error: 'SERVER',
        message: 'Server is not configured. Check backend/.env.' });
    }

    const endpoint = buildEndpoint(shortcode);
    console.log('[api] →', endpoint);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    let apiRes;
    try {
      apiRes = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key': RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST,
          'Accept': 'application/json'
        },
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      console.log('[api] ✗ fetch failed:', err && err.message);
      return res.status(504).json({ success: false, error: 'TIMEOUT',
        message: 'Something went wrong. Please try again.' });
    }
    clearTimeout(timer);

    console.log('[api] ← status', apiRes.status);

    if (apiRes.status === 429) {
      return res.status(429).json({ success: false, error: 'RATE_LIMIT',
        message: 'Too many requests. Please try again later.' });
    }
    if (apiRes.status === 404) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND',
        message: "We couldn't find this Reel." });
    }
    if (apiRes.status === 401 || apiRes.status === 403) {
      console.log('[api] ✗ auth error — check RAPIDAPI_KEY');
      return res.status(502).json({ success: false, error: 'API',
        message: 'Something went wrong. Please try again.' });
    }
    if (!apiRes.ok) {
      const text = await apiRes.text().catch(() => '');
      console.log('[api] ✗ body:', text.slice(0, 400));
      return res.status(502).json({ success: false, error: 'API',
        message: 'Something went wrong. Please try again.' });
    }

    let json;
    try { json = await apiRes.json(); }
    catch (e) {
      return res.status(502).json({ success: false, error: 'API',
        message: 'Something went wrong. Please try again.' });
    }

    const media = findMediaNode(json);
    if (!media) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND',
        message: "We couldn't find this Reel." });
    }

    const result = normaliseMedia(media, shortcode);

    if (result.error === 'PRIVATE') {
      return res.status(403).json({ success: false, error: 'PRIVATE',
        message: 'This Reel is private or unavailable.' });
    }
    if (result.error === 'NO_VIDEO') {
      return res.status(404).json({ success: false, error: 'NO_VIDEO',
        message: 'No downloadable video was found.' });
    }

    console.log('[ok]', result.username, '·', result.videos.length, 'qualities');
    return res.json({ success: true, data: result });

  } catch (err) {
    console.log('[err]', err && err.message);
    return res.status(500).json({ success: false, error: 'SERVER',
      message: 'Something went wrong. Please try again.' });
  }
});

/* GET /api/test — raw diagnostic */
app.get('/api/test', async (req, res) => {
  const shortcode = String(req.query.shortcode || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!shortcode) return res.status(400).json({ error: 'pass ?shortcode=ABC123' });
  if (!RAPIDAPI_KEY || !RAPIDAPI_HOST || !RAPIDAPI_ENDPOINT) {
    return res.json({ ok: false, reason: 'RapidAPI env vars missing' });
  }
  const endpoint = buildEndpoint(shortcode);
  const out = { ok: false, endpoint, shortcode };
  try {
    const r = await fetch(endpoint, {
      headers: {
        'X-RapidAPI-Key': RAPIDAPI_KEY,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
        'Accept': 'application/json'
      }
    });
    out.status = r.status;
    const text = await r.text();
    out.bodyPreview = text.slice(0, 1200);
    try {
      const json = JSON.parse(text);
      out.jsonKeys = Object.keys(json).slice(0, 20);
      const media = findMediaNode(json);
      out.foundMediaNode = !!media;
      if (media) out.videoVersions = (media.video_versions || []).length;
      out.ok = true;
    } catch (_) { out.parseError = true; }
    res.json(out);
  } catch (err) {
    out.fetchError = err && err.message;
    res.json(out);
  }
});

/* GET /api/health */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    configured: Boolean(RAPIDAPI_KEY && RAPIDAPI_HOST && RAPIDAPI_ENDPOINT)
  });
});

/* Whitelisted media proxy */
function isAllowedMediaUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h.endsWith('.cdninstagram.com') || h.endsWith('.fbcdn.net');
  } catch (_) { return false; }
}

app.get('/api/media', async (req, res) => {
  const raw = req.query.url;
  if (typeof raw !== 'string' || !raw) return res.status(400).json({ error: 'INVALID_URL' });
  if (!isAllowedMediaUrl(raw)) return res.status(400).json({ error: 'INVALID_URL' });

  let filename = String(req.query.name || 'reel').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
  if (!filename) filename = 'reel';
  if (!/\.mp4$/i.test(filename)) filename += '.mp4';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const up = await fetch(raw, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!up.ok || !up.body) return res.status(502).json({ error: 'API' });

    res.setHeader('Content-Type', up.headers.get('content-type') || 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Cache-Control', 'no-store');
    const cl = up.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);

    Readable.fromWeb(up.body).pipe(res);
    req.on('close', () => { try { controller.abort(); } catch (_) {} });
  } catch (err) {
    clearTimeout(timer);
    if (!res.headersSent) res.status(502).json({ error: 'API' });
    else try { res.end(); } catch (_) {}
  }
});

/* Static frontend */
app.use('/backend', (req, res) => res.status(404).end());
app.use(express.static(path.join(__dirname, '..'), { index: 'index.html', dotfiles: 'ignore' }));

/* 404 for /api */
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'NOT_FOUND' }));

/* Error handler */
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'INVALID_URL',
      message: 'Please paste a valid Instagram Reel URL.' });
  }
  console.log('[err]', err && err.message);
  res.status(500).json({ success: false, error: 'SERVER',
    message: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => {
  console.log('  ✅ Listening on http://localhost:' + PORT);
  console.log('  ✅ Health:  http://localhost:' + PORT + '/api/health');
  console.log('  ✅ Test:    http://localhost:' + PORT + '/api/test?shortcode=DEywd9btU74');
  console.log('  ➜  Open http://localhost:' + PORT + ' in your browser');
  console.log('');
});
