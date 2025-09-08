const express = require('express');
const YtDlpManager = require('../managers/YtDlpManager.js');
const CacheManager = require('../managers/CacheManager.js');
const TorrentSearchManager = require('../managers/TorrentSearchManager.js');
const { SERVER_CONSTANTS } = require('../config/constants.js');
const { 
  computeMatchScore
} = require('../utils');

const router = express.Router();
const cache = new CacheManager();

// Initialize the torrent search manager
const torrentSearchManager = new TorrentSearchManager();

/**
 * Unified source search endpoint for renderer
 * GET /api/source-search?title=title&artist=artist&type=torrents|youtube
 */
router.get('/source-search', async (req, res) => {
  try {
    // Only accept title, artist, and type parameters
    const title = String(req.query.title || '').trim();
    const artist = String(req.query.artist || '').trim();
    const type = String(req.query.type || 'torrents').trim().toLowerCase();
    
    // Validate type parameter
    if (!['torrents', 'youtube'].includes(type)) {
      return res.status(400).json({ 
        success: false,
        error: 'type must be either "torrents" or "youtube"' 
      });
    }
    
    const includeTorrents = type === 'torrents';
    const includeYoutube = type === 'youtube';

    // Create search query from title and artist
    const searchQuery = (title ? (title + (artist ? ' ' + artist : '')) : '');
    if (!searchQuery) {
      return res.status(400).json({ 
        success: false,
        error: 'title parameter is required' 
      });
    }

    const results = [];

    // YouTube search
    if (includeYoutube) {
      console.log('[source-search] performing youtube search for', searchQuery);
      try {
        const ytdlpManager = new YtDlpManager();
        const entries = await ytdlpManager.searchVideos(searchQuery, SERVER_CONSTANTS.LIMITS.DEFAULT_LIMIT);
        
        if (!entries.length) {
          console.warn('[source-search] youtube search returned no entries for:', searchQuery);
        }

        const scored = [];
        const queryTitleForScore = title || searchQuery || '';
        const queryArtistForScore = artist || '';
        const stripParen = (s) => String(s || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g,' ').trim();
        const coreQuery = stripParen(queryTitleForScore);
        const coreQueryTokens = coreQuery.toLowerCase().split(/\s+/).filter(Boolean);

        for (const e of entries.slice(0, SERVER_CONSTANTS.LIMITS.DEFAULT_LIMIT)) {
          const ytTitle = e.title || '';
          const candidateArtist = e.uploader || '';
          let s = computeMatchScore(queryTitleForScore, queryArtistForScore, ytTitle, candidateArtist);
          
          // Heuristic boost for good token coverage
          if (coreQueryTokens.length) {
            const coreCandidate = stripParen(ytTitle).toLowerCase();
            let covered = 0;
            for (const tok of coreQueryTokens) {
              if (coreCandidate.includes(tok)) covered++;
            }
            const coverage = covered / coreQueryTokens.length;
            if (coverage >= SERVER_CONSTANTS.LIMITS.COVERAGE_THRESHOLD) {
              s = Math.max(s, Math.min(85, Math.round(s + SERVER_CONSTANTS.LIMITS.SCORE_BOOST * coverage)));
            }
          }
          
          scored.push({ entry: e, _score: s });
        }

        // Filter and sort by score
        scored.sort((a, b) => b._score - a._score);
        for (const item of scored) {
          if ((item._score || 0) < SERVER_CONSTANTS.LIMITS.MIN_SCORE) break;
          
          const e = item.entry;
          results.push({
            type: 'youtube',
            title: e.title || null,
            source: 'youtube',
            id: e.id || null,
            url: e.webpage_url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null),
            duration: e.duration || null,
            uploader: e.uploader || null,
            _score: item._score
          });
        }
      } catch (e) {
        console.warn('[source-search] youtube search failed', e?.message || e);
      }
    }

    // Torrent search
    if (includeTorrents) {
      try {
        const opts = { 
          title: title || undefined, 
          artist: artist || undefined
        };
        
        console.log('[source-search] performing torrent search for', searchQuery);
        const tResults = await torrentSearchManager.searchAll(opts);
        
        if (Array.isArray(tResults) && tResults.length) {
          // TorrentSearchManager already provides scored and filtered results
          for (const t of tResults.slice(0, SERVER_CONSTANTS.LIMITS.DEFAULT_LIMIT)) {
            const thisResult = {
              type: 'torrent',
              title: t.title || t.name || null,
              source: t.source || 'torrent',
              infoHash: t.infoHash || null,
              magnetURI: t.magnetURI || null,
              seeders: t.seeders ?? t.seeds ?? null,
              size: t.size || t.filesize || null,
              _score: t._score || 0
            };
            
            // Only include torrents with seeders
            if (thisResult.seeders > 0) {
              results.push(thisResult);
            }
          }
        }
      } catch (e) {
        console.warn('[source-search] torrent search failed', e?.message || e);
      }
    }

    const finalResults = results.slice(0, SERVER_CONSTANTS.LIMITS.DEFAULT_LIMIT);
    
    res.json({
      success: true,
      results: finalResults
    });

  } catch (error) {
    console.error('[SearchRoutes] Unified search error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Search failed'
    });
  }
});

module.exports = router;
