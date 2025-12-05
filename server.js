/**
 * Hatsune Flash - AI Assistant Backend
 * Unified API for YouTube, Instagram, TikTok, AI tools
 * with proxy download, caching, retries, rate-limiting
 */

const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const NodeCache = require('node-cache');
const { URL } = require('url');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Basic middlewares
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter
const limiter = rateLimit({
  windowMs: 30 * 1000, // 30s
  max: 30,             // 30 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', limiter);

// Cache: 5 minutes TTL default
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Axios instance with defaults
const http = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'HatsuneFlash/1.0 (+https://github.com/hatsuneflash)'
  },
  maxRedirects: 5
});

// Helper: validate any URL
function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// Helper: quick provider-specific validators
function isYouTubeUrl(u) {
  if (!u) return false;
  try {
    const p = new URL(u);
    const host = p.hostname.toLowerCase();
    return host.includes('youtube.com') || host.includes('youtu.be');
  } catch (e) { return false; }
}
function isInstagramUrl(u) {
  if (!u) return false;
  try {
    const p = new URL(u);
    return p.hostname.toLowerCase().includes('instagram.com') || p.hostname.toLowerCase().includes('instagr.am');
  } catch (e) { return false; }
}
function isTikTokUrl(u) {
  if (!u) return false;
  try {
    const p = new URL(u);
    const host = p.hostname.toLowerCase();
    return host.includes('tiktok.com') || host.includes('vt.tiktok.com') || host.includes('vm.tiktok.com');
  } catch (e) { return false; }
}

// Helper: retry wrapper
async function fetchWithRetries(configOrUrl, opts = {}) {
  const retries = opts.retries || 2;
  const backoffMs = opts.backoffMs || 500;
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    try {
      // allow passing full axios config or url string
      const resp = typeof configOrUrl === 'string'
        ? await http.get(configOrUrl)
        : await http.request(configOrUrl);
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        // exponential-ish backoff
        await new Promise(r => setTimeout(r, backoffMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// Generic safe JSON response wrapper
function handleProviderResponse(res, providerName, raw) {
  if (!raw) {
    return res.status(502).json({ status: 'error', provider: providerName, message: 'Empty response from provider' });
  }
  // If provider returned error object
  if (raw.error || raw.status === 'error' || raw.code?.toString().startsWith('4') || raw.code?.toString().startsWith('5')) {
    return res.status(502).json({ status: 'error', provider: providerName, detail: raw });
  }
  return null;
}

/* ============================
   API Routes with /api prefix
   ============================ */

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    services: {
      youtube: 'ryzendesu/noembed',
      instagram: 'ryzendesu',
      tiktok: 'tikwm/ryzendesu',
      ai: 'ryzendesu'
    },
    note: 'Use only with content you have permission to use.'
  });
});

// YouTube Info
app.get('/api/youtube/info', async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ status: 'error', message: 'Missing ?url= parameter' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ status: 'error', message: 'URL is not YouTube' });

  const cacheKey = `youtube:info:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ status: 'success', cached: true, data: cached });

  try {
    // use noembed as lightweight metadata provider
    const api = `https://noembed.com/embed?url=${encodeURIComponent(url)}`;
    const resp = await fetchWithRetries(api);
    const data = resp.data;
    // validate
    const err = handleProviderResponse(res, 'noembed', data);
    if (err) return;

    const out = {
      title: data.title || null,
      author_name: data.author_name || null,
      author_url: data.author_url || null,
      thumbnail: data.thumbnail_url || null,
      provider: data.provider_name || 'YouTube',
      url
    };

    cache.set(cacheKey, out);
    return res.json({ status: 'success', cached: false, data: out });
  } catch (err) {
    console.error('/youtube/info err:', err.message || err);
    return res.status(502).json({ status: 'error', provider: 'noembed', message: err.message || 'Failed' });
  }
});

// YouTube MP4
app.get('/api/youtube/mp4', async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ status: 'error', message: 'Missing ?url=' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ status: 'error', message: 'Invalid YouTube URL' });

  const cacheKey = `youtube:mp4:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ status: 'success', cached: true, data: cached });

  try {
    const api = `https://api.ryzendesu.com/ytmp4?url=${encodeURIComponent(url)}`;
    const resp = await fetchWithRetries(api);
    const data = resp.data;
    const err = handleProviderResponse(res, 'ryzendesu-ytmp4', data);
    if (err) return;
    const result = data.result || data;
    cache.set(cacheKey, result);
    return res.json({ status: 'success', cached: false, data: result });
  } catch (err) {
    console.error('/youtube/mp4 err:', err.message || err);
    return res.status(502).json({ status: 'error', provider: 'ryzendesu-ytmp4', message: err.message || 'Failed' });
  }
});

// YouTube MP3
app.get('/api/youtube/mp3', async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ status: 'error', message: 'Missing ?url=' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ status: 'error', message: 'Invalid YouTube URL' });

  const cacheKey = `youtube:mp3:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ status: 'success', cached: true, data: cached });

  try {
    const api = `https://api.ryzendesu.com/ytmp3?url=${encodeURIComponent(url)}`;
    const resp = await fetchWithRetries(api);
    const data = resp.data;
    const err = handleProviderResponse(res, 'ryzendesu-ytmp3', data);
    if (err) return;
    const result = data.result || data;
    cache.set(cacheKey, result);
    return res.json({ status: 'success', cached: false, data: result });
  } catch (err) {
    console.error('/youtube/mp3 err:', err.message || err);
    return res.status(502).json({ status: 'error', provider: 'ryzendesu-ytmp3', message: err.message || 'Failed' });
  }
});

// Instagram
app.get('/api/instagram', async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ status: 'error', message: 'Missing ?url=' });
  if (!isInstagramUrl(url)) return res.status(400).json({ status: 'error', message: 'Invalid Instagram URL' });

  const cacheKey = `instagram:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ status: 'success', cached: true, data: cached });

  try {
    const api = `https://api.ryzendesu.com/igdl?url=${encodeURIComponent(url)}`;
    const resp = await fetchWithRetries(api);
    const data = resp.data;
    const err = handleProviderResponse(res, 'ryzendesu-igdl', data);
    if (err) return;

    // Normalize structure for client
    const r = data.result || {};
    const items = Array.isArray(r.data) ? r.data.map(i => ({
      type: i.type || null,
      cover: i.cover || i.thumbnail || null,
      url: i.url || i.src || null,
      size: i.size || null,
      quality: i.quality || null
    })) : [];

    const out = {
      provider: 'ryzendesu',
      original_url: url,
      type: r.type || null,
      username: r.username || null,
      caption: r.caption || null,
      title: r.title || null,
      media_count: items.length,
      media: items
    };

    cache.set(cacheKey, out);
    return res.json({ status: 'success', cached: false, data: out });
  } catch (err) {
    console.error('/instagram err:', err.message || err);
    return res.status(502).json({ status: 'error', provider: 'ryzendesu-igdl', message: err.message || 'Failed' });
  }
});

// TikTok
app.get('/api/tiktok', async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ status: 'error', message: 'Missing ?url=' });
  if (!isTikTokUrl(url)) return res.status(400).json({ status: 'error', message: 'Invalid TikTok URL' });

  const cacheKey = `tiktok:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ status: 'success', cached: true, data: cached });

  try {
    // try tikwm first (common), fallback to ryzendesu
    const providers = [
      `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`,
      `https://api.ryzendesu.com/tiktok?url=${encodeURIComponent(url)}`
    ];
    let data = null;
    for (const api of providers) {
      try {
        const resp = await fetchWithRetries(api);
        data = resp.data;
        if (data) break;
      } catch (e) {
        // try next
      }
    }
    if (!data) {
      return res.status(502).json({ status: 'error', provider: 'all', message: 'All providers failed' });
    }
    const err = handleProviderResponse(res, 'tiktok-provider', data);
    if (err) return;

    const r = data.result || data.data || data;
    // attempt to normalize
    const media = (r.data || r.medias || r.media || []).map(i => ({
      type: i.type || i.format || null,
      cover: i.cover || i.thumbnail || null,
      url: i.url || i.play || i.src || null,
      size: i.size || null,
      quality: i.quality || null
    }));

    const out = {
      provider: 'tiktok-public',
      original_url: url,
      title: r.title || r.desc || null,
      author: r.author || r.creator || null,
      media_count: media.length,
      media
    };

    cache.set(cacheKey, out);
    return res.json({ status: 'success', cached: false, data: out });
  } catch (err) {
    console.error('/tiktok err:', err.message || err);
    return res.status(502).json({ status: 'error', provider: 'tiktok', message: err.message || 'Failed' });
  }
});

// AI Tools
const allowedAnimeModels = ['anime', 'loli'];
const allowedFaceFilters = ['coklat', 'hitam', 'nerd', 'piggy', 'carbon', 'botak'];

// AI to Anime
app.get('/api/ai/toanime', async (req, res) => {
  const imageUrl = (req.query.url || '').trim();
  const model = (req.query.model || '').trim().toLowerCase();

  if (!imageUrl) return res.status(400).json({ status: 'error', message: 'Missing ?url=' });
  if (!isValidHttpUrl(imageUrl)) return res.status(400).json({ status: 'error', message: 'Invalid image URL' });
  if (!allowedAnimeModels.includes(model)) return res.status(400).json({ status: 'error', message: `Invalid model. Allowed: ${allowedAnimeModels.join(', ')}` });

  const cacheKey = `ai:toanime:${model}:${imageUrl}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ status: 'success', cached: true, data: cached });

  try {
    const api = `https://api.ryzendesu.com/api/ai/toanime?url=${encodeURIComponent(imageUrl)}&model=${encodeURIComponent(model)}`;
    const resp = await fetchWithRetries(api, { retries: 3, backoffMs: 600 });
    const data = resp.data;
    const err = handleProviderResponse(res, 'ryzendesu-toanime', data);
    if (err) return;

    const result = data.result || data;
    cache.set(cacheKey, result);
    return res.json({ status: 'success', cached: false, data: result });
  } catch (err) {
    console.error('/ai/toanime err:', err.message || err);
    return res.status(502).json({ status: 'error', provider: 'ryzendesu-toanime', message: err.message || 'Failed' });
  }
});

// AI Face Edit
app.get('/api/ai/edit', async (req, res) => {
  const imageUrl = (req.query.url || '').trim();
  const filter = (req.query.filter || '').trim().toLowerCase();

  if (!imageUrl) return res.status(400).json({ status: 'error', message: 'Missing ?url=' });
  if (!isValidHttpUrl(imageUrl)) return res.status(400).json({ status: 'error', message: 'Invalid image URL' });
  if (!allowedFaceFilters.includes(filter)) return res.status(400).json({ status: 'error', message: `Invalid filter. Allowed: ${allowedFaceFilters.join(', ')}` });

  const cacheKey = `ai:edit:${filter}:${imageUrl}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ status: 'success', cached: true, data: cached });

  try {
    const api = `https://api.ryzendesu.com/api/ai/negro?url=${encodeURIComponent(imageUrl)}&filter=${encodeURIComponent(filter)}`;
    const resp = await fetchWithRetries(api, { retries: 3, backoffMs: 600 });
    const data = resp.data;
    const err = handleProviderResponse(res, 'ryzendesu-ai-edit', data);
    if (err) return;

    const result = data.result || data;
    cache.set(cacheKey, result);
    return res.json({ status: 'success', cached: false, data: result });
  } catch (err) {
    console.error('/ai/edit err:', err.message || err);
    return res.status(502).json({ status: 'error', provider: 'ryzendesu-ai-edit', message: err.message || 'Failed' });
  }
});

// Proxy download endpoint
app.get('/api/download', async (req, res) => {
  const mediaUrl = (req.query.url || '').trim();
  if (!mediaUrl) return res.status(400).json({ status: 'error', message: 'Missing ?url=' });
  if (!isValidHttpUrl(mediaUrl)) return res.status(400).json({ status: 'error', message: 'Invalid media URL' });

  // Basic host blacklist
  try {
    const parsed = new URL(mediaUrl);
    const host = parsed.hostname.toLowerCase();
    const blocked = ['localhost', '127.0.0.1', '::1'];
    if (blocked.includes(host)) return res.status(400).json({ status: 'error', message: 'Host not allowed' });
  } catch (e) {
    return res.status(400).json({ status: 'error', message: 'Bad media URL' });
  }

  try {
    const upstream = await fetchWithRetries({
      url: mediaUrl,
      method: 'GET',
      responseType: 'stream',
      timeout: 20000
    }, { retries: 2, backoffMs: 500 });

    const headers = upstream.headers || upstream.data?.headers || {};
    const contentType = headers['content-type'] || 'application/octet-stream';
    const contentLength = headers['content-length'];

    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Type', contentType);

    // attempt to infer extension
    let ext = '';
    if (contentType.includes('image/')) ext = '.jpg';
    else if (contentType.includes('video/')) ext = '.mp4';
    else if (contentType.includes('audio/')) ext = '.mp3';

    res.setHeader('Content-Disposition', `attachment; filename="media${ext}"`);

    upstream.data.pipe(res);
    upstream.data.on('error', e => {
      console.error('/download stream error', e.message || e);
      try { res.end(); } catch (err) {}
    });
  } catch (err) {
    console.error('/download err:', err.message || err);
    return res.status(502).json({ status: 'error', message: 'Failed to fetch media', detail: err.message || 'Upstream failed' });
  }
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Hatsune Flash running on http://localhost:${PORT}`);
  console.log(`API available at http://localhost:${PORT}/api/health`);
});