const express = require('express');
const YtDlpManager = require('../managers/YtDlpManager');
const CacheManager = require('../managers/CacheManager');
const YouTubeProxy = require('../utils/YouTubeProxy');
const { SERVER_CONSTANTS } = require('../config/constants');

const router = express.Router();
const cache = new CacheManager();

/**
 * YouTube streaming endpoint with info mode support
 * GET /source/youtube?id=VIDEO_ID&get=info|stream&format=FORMAT
 */
router.get('/youtube', async (req, res) => {
  try {
    const debug = String(req.query.debug || '').trim() === '1';
    const raw = String(req.query.id || req.query.url || '').trim();
    const mode = String(req.query.get || 'info').toLowerCase();
    const formatPreference = req.query.format || 'bestaudio[ext=m4a]';
    const forceInfo = String(req.query.forceInfo || req.query.force || '').toLowerCase() === '1';

    const tStart = Date.now();
    if (debug) console.log('[youtube] incoming', { raw, mode, formatPreference });

    // Validate inputs
    if (!raw && mode !== 'search') {
      return res.status(400).json({ 
        success: false,
        error: 'id or url required' 
      });
    }

    // Search mode redirects to unified search
    if (mode === 'search') {
      return res.status(307).json({ 
        success: false,
        error: 'moved', 
        reason: 'use /api/source-search?type=youtube&title=title&artist=artist', 
      });
    }

    // Normalize target URL
    let target;
    if (/^https?:\/\//i.test(raw)) {
      target = raw;
    } else {
      target = `https://www.youtube.com/watch?v=${encodeURIComponent(raw)}`;
    }

    if (debug) console.log('[youtube] target =', target);

    // Set early headers
    if (!res.headersSent) {
      res.setHeader('Accept-Ranges', 'bytes');
      const earlyContentType = mode === 'info' ? 'application/json' : 'application/octet-stream';
      res.setHeader('Content-Type', earlyContentType);
    }

    // Get video info (with caching)
    let info = null;
    const ytdlpManager = new YtDlpManager();
    
    // Try cache first unless force refresh
    if (!forceInfo) {
      const cached = cache.get(target);
      if (cached) {
        if (debug) console.log('[youtube] using cached info for', target);
        info = cached;
      }
    }

    // Get fresh info if not cached
    if (!info) {
      info = await ytdlpManager.getVideoInfo(target, formatPreference);
      
      // Cache the info
      if (info) {
        cache.set(target, info, SERVER_CONSTANTS.YOUTUBE_CACHE_TTL);
      }
    }

    if (!info) {
      return res.status(404).json({
        success: false,
        error: 'Video info not available'
      });
    }

    // Pick audio format
    const chosen = ytdlpManager.pickAudioFormat(info);
    if (!chosen || !chosen.url) {
      if (debug) {
        console.warn('[youtube] no direct audio format with URL found; formats:', 
                   Array.isArray(info?.formats) ? info.formats.map(f => f.ext).slice(0,10) : 'none');
      }
      return res.status(422).json({ 
        success: false,
        error: 'no direct audio-only format available; would require remux/merge (ffmpeg)' 
      });
    }

    if (debug) {
      console.log('[youtube] chosen format ext=', chosen.ext, 'acodec=', chosen.acodec, 'urlPresent=', !!chosen.url);
    }

    // Info mode: return metadata
    if (mode === 'info') {
      const metadata = {
        success: true,
        data: {
          title: info?.title || null,
          duration: info?.duration || null,
          uploader: info?.uploader || info?.uploader_id || null,
          format: {
            ext: chosen.ext || null,
            acodec: chosen.acodec || null,
            mime_type: chosen.mime_type || null,
            url: chosen.url || null,
            filesize: chosen.filesize || chosen.filesize_approx || null,
          },
          requested_at: Date.now(),
        },
        cached: !!forceInfo
      };
      return res.json(metadata);
    }

    // Stream mode: proxy the audio URL
    try {
      await YouTubeProxy.proxyUrl(chosen.url, req, res, { debug });
      return;
    } catch (proxyErr) {
      if (debug) {
        console.warn('[youtube] primary CDN proxy failed', proxyErr?.message || proxyErr);
      }

      // Try fallback formats
      if (Array.isArray(info?.formats) && info.formats.length) {
        const tried = new Set([chosen.url]);
        const candidates = info.formats
          .filter(f => f && f.url && f.acodec && f.acodec !== 'none')
          .sort((a, b) => (a.requested ? -1 : 0) - (b.requested ? -1 : 0));

        for (const fmt of candidates) {
          try {
            if (!fmt.url || tried.has(fmt.url)) continue;
            if (debug) {
              console.log('[youtube] trying fallback format', fmt.ext || fmt.format || 'unknown');
            }
            tried.add(fmt.url);
            await YouTubeProxy.proxyUrl(fmt.url, req, res, { debug });
            return;
          } catch (e2) {
            if (debug) {
              console.warn('[youtube] fallback format failed', e2?.message || e2);
            }
            // Continue to next format
          }
        }
      }

      // All attempts failed
      if (!res.headersSent) {
        return res.status(502).json({ 
          success: false,
          error: 'failed to proxy any CDN url', 
          reason: proxyErr?.message || String(proxyErr) 
        });
      } else {
        try { res.end(); } catch (_) {}
        return;
      }
    }

  } catch (err) {
    const debug = String(req.query.debug || '').trim() === '1';
    if (debug) {
      console.error('[youtube] unexpected error', err?.stack || err);
    }
    try { 
      if (!res.headersSent) {
        res.status(500).json({ 
          success: false,
          error: err?.message || String(err) 
        }); 
      } else {
        res.end(); 
      }
    } catch (_) {}
  }
});

module.exports = router;
