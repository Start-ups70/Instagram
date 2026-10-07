/* ============================================================
   REELS DOWNLOADER — backend proxy
   ------------------------------------------------------------
   - Keeps the RapidAPI key server-side (never sent to browser)
   - Validates Instagram Reel URLs and extracts the shortcode
   - Calls the RapidAPI Instagram provider
   - Normalises video_versions / image_versions2
   - Provides a WHITELISTED media proxy for Instagram CDN hosts
     (blocks arbitrary URL fetching / SSRF)
   - Serves the static frontend from the project root
   ============================================================ */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

const RAPIDAPI_KEY      = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST     = process.env.RAPIDAPI_HOST;
const RAPIDAPI_ENDPOINT = process.env.RAPIDAPI_ENDPOINT;
const CORS_ORIGIN       = process.env.CORS_ORIGIN;

/* ------------------------------------------------------------
   1. Core middleware
   ------------------------------------------------------------ */
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '10kb' }));

/* Security headers */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

/* CORS — only if the frontend lives on a different origin */
if (CORS_ORIGIN) {
  const allowed = CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
  app.use(cors({ origin: allowed }));
}

/* ------------------------------------------------------------
   2. Rate limiters
   ------------------------------------------------------------ */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'RATE_LIMIT',
      message: 'Too many requests. Please try again later.'
    });
  }
});

const mediaLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'RATE_LIMIT',
      message: 'Too many requests. Please try again later.'
    });
  }
});

/* ------------------------------------------------------------
   3. Static frontend (served from the project root)
   ------------------------------------------------------------ */
app.use('/backend', (req, res) => res.status(404).end()); // hide backend folder

app.use(express.static(path.join(__dirname, '..'), {
  index: 'index.html',
  dotfiles: 'ignore',
  extensions: false
}));

/* ------------------------------------------------------------
   4. Helpers
   ------------------------------------------------------------ */

/* Only accept instagram.com/reel|reels/<shortcode> */
const REEL_RE = /^https?:\/\/(?:www\.)?instagram\.com\/reels?\/([A-Za-z0-9_-]+)/i;

function extractShortcode(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  const m = trimmed.match(REEL_RE);
  return m ? m[1] : null;
}

/* Reels are portrait: the "quality" is the SMALLER dimension (720x1280 -> 720p) */
function qualityFromDimensions(w, h) {
  const base = Math.min(Number(w) || 0, Number(h) || 0);
  return base ? base + 'p' : 'Video';
}

/* Walk the RapidAPI response to find the node containing video_versions.
   Handles common wrappers: { data }, { result }, { items:[...] }, etc. */
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

/* Best thumbnail from image_versions2.candidates */
function pickThumbnail(media) {
  const candidates = media && media.image_versions2 && Array.isArray(media.image_versions2.candidates)
    ? media.image_versions2.candidates
    : [];

  if (!candidates.length) return '';

  const sorted = candidates
    .filter(c => c && c.url)
    .slice()
    .sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));

  return sorted.length ? sorted[0].url : '';
}

/* Normalise a media node into our public API shape.
   - Deduplicates by URL
   - Deduplicates by resolution (same quality shown once)
   - Sorts highest resolution first */
function normaliseMedia(media, shortcode) {
  if (media.user && media.user.is_private === true) {
    return { error: 'PRIVATE' };
  }

  const raw = Array.isArray(media.video_versions) ? media.video_versions : [];
  if (!raw.length) return { error: 'NO_VIDEO' };

  const seenUrl = new Set();
  const seenRes = new Set();

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
      const resKey = v.width + 'x' + v.height;
      if (seenRes.has(resKey)) return false;
      seenRes.add(resKey);
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

/* ------------------------------------------------------------
   5. POST /api/download
   ------------------------------------------------------------ */
app.post('/api/download', apiLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const rawUrl = body.url;

    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_URL',
        message: 'Please paste a valid Instagram Reel URL.'
      });
    }

    const shortcode = extractShortcode(rawUrl);
    if (!shortcode) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_URL',
        message: 'Please paste a valid Instagram Reel URL.'
      });
    }

    if (!RAPIDAPI_KEY || !RAPIDAPI_HOST || !RAPIDAPI_ENDPOINT) {
      console.error('[config] Missing RAPIDAPI_KEY / RAPIDAPI_HOST / RAPIDAPI_ENDPOINT');
      return res.status(500).json({
        success: false,
        error: 'SERVER',
        message: 'Something went wrong. Please try again.'
      });
    }

    /* Build the RapidAPI URL from the endpoint template */
    const canonical = 'https://www.instagram.com/reel/' + shortcode + '/';
    const endpoint = RAPIDAPI_ENDPOINT
      .replace(/\{shortcode\}/g, encodeURIComponent(shortcode))
      .replace(/\{url\}/g, encodeURIComponent(canonical));

    /* Fetch with timeout */
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
      console.error('[rapidapi] fetch failed:', err && err.message);
      return res.status(504).json({
        success: false,
        error: 'TIMEOUT',
        message: 'Something went wrong. Please try again.'
      });
    }
    clearTimeout(timer);

    if (apiRes.status === 429) {
      return res.status(429).json({
        success: false,
        error: 'RATE_LIMIT',
        message: 'Too many requests. Please try again later.'
      });
    }
    if (apiRes.status === 404) {
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: "We couldn't find this Reel."
      });
    }
    if (!apiRes.ok) {
      console.error('[rapidapi] status', apiRes.status);
      return res.status(502).json({
        success: false,
        error: 'API',
        message: 'Something went wrong. Please try again.'
      });
    }

    let json;
    try {
      json = await apiRes.json();
    } catch (_) {
      return res.status(502).json({
        success: false,
        error: 'API',
        message: 'Something went wrong. Please try again.'
      });
    }

    const media = findMediaNode(json);
    if (!media) {
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: "We couldn't find this Reel."
      });
    }

    const result = normaliseMedia(media, shortcode);

    if (result.error === 'PRIVATE') {
      return res.status(403).json({
        success: false,
        error: 'PRIVATE',
        message: 'This Reel is private or unavailable.'
      });
    }
    if (result.error === 'NO_VIDEO') {
      return res.status(404).json({
        success: false,
        error: 'NO_VIDEO',
        message: 'No downloadable video was found.'
      });
    }

    return res.json({ success: true, data: result });

  } catch (err) {
    console.error('[server] /api/download error:', err && err.message);
    return res.status(500).json({
      success: false,
      error: 'SERVER',
      message: 'Something went wrong. Please try again.'
    });
  }
});

/* ------------------------------------------------------------
   6. GET /api/media — WHITELISTED Instagram CDN proxy
   Only https://*.cdninstagram.com and https://*.fbcdn.net are allowed.
   No arbitrary URL proxying.
   ------------------------------------------------------------ */
function isAllowedMediaUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host.endsWith('.cdninstagram.com') || host.endsWith('.fbcdn.net');
  } catch (_) {
    return false;
  }
}

app.get('/api/media', mediaLimiter, async (req, res) => {
  const raw = req.query.url;
  if (typeof raw !== 'string' || !raw) {
    return res.status(400).json({ success: false, error: 'INVALID_URL' });
  }
  if (!isAllowedMediaUrl(raw)) {
    return res.status(400).json({ success: false, error: 'INVALID_URL' });
  }

  let filename = String(req.query.name || 'reel').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80);
  if (!filename) filename = 'reel';
  if (!/\.mp4$/i.test(filename)) filename += '.mp4';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const upstream = await fetch(raw, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ReelsDownloader/1.0)',
        'Accept': '*/*'
      },
      signal: controller.signal,
      redirect: 'follow'
    });

    clearTimeout(timer);

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ success: false, error: 'API' });
    }

    const ctype = upstream.headers.get('content-type') || 'video/mp4';
    const clen = upstream.headers.get('content-length');

    res.setHeader('Content-Type', ctype);
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (clen) res.setHeader('Content-Length', clen);

    Readable.fromWeb(upstream.body).pipe(res);

    req.on('close', () => {
      try { controller.abort(); } catch (_) {}
    });

  } catch (err) {
    clearTimeout(timer);
    if (!res.headersSent) {
      res.status(502).json({ success: false, error: 'API' });
    } else {
      try { res.end(); } catch (_) {}
    }
  }
});

/* ------------------------------------------------------------
   7. Health check
   ------------------------------------------------------------ */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    configured: Boolean(RAPIDAPI_KEY && RAPIDAPI_HOST && RAPIDAPI_ENDPOINT)
  });
});

/* ------------------------------------------------------------
   8. 404 for unknown API routes
   ------------------------------------------------------------ */
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'NOT_FOUND' });
});

/* ------------------------------------------------------------
   9. Error handler (JSON parse errors, etc.)
   ------------------------------------------------------------ */
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      error: 'INVALID_URL',
      message: 'Please paste a valid Instagram Reel URL.'
    });
  }
  console.error('[server] unhandled error:', err && err.message);
  res.status(500).json({
    success: false,
    error: 'SERVER',
    message: 'Something went wrong. Please try again.'
  });
});

/* ------------------------------------------------------------
   10. Start
   ------------------------------------------------------------ */
app.listen(PORT, () => {
  console.log('');
  console.log('  Reels Downloader');
  console.log('  ------------------------------------------');
  console.log('  URL:        http://localhost:' + PORT);
  console.log('  RapidAPI:   ' + (RAPIDAPI_KEY ? 'configured' : 'NOT configured — set backend/.env'));
  console.log('');
});
