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
 * Convert YouTube duration string to seconds
 * @param {string} durationString - Duration in format "MM:SS" or "HH:MM:SS"
 * @returns {number|null} Duration in seconds or null if invalid
 */
function parseDurationToSeconds(durationString) {
  if (!durationString || typeof durationString !== 'string') {
    return null;
  }
  
  const parts = durationString.split(':').map(part => parseInt(part, 10));
  
  if (parts.length === 2) {
    // MM:SS format
    const [minutes, seconds] = parts;
    if (isNaN(minutes) || isNaN(seconds)) return null;
    return minutes * 60 + seconds;
  } else if (parts.length === 3) {
    // HH:MM:SS format
    const [hours, minutes, seconds] = parts;
    if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }
  
  return null;
}

/**
 * Search YouTube using the internal API
 * @param {string} query - Search query
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Array of video entries
 */
async function searchYouTubeAPI(query, limit = 10) {
  try {
    const response = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
      "headers": {
        "accept": "*/*",
        "accept-language": "en;q=0.8",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "pragma": "no-cache",
        "priority": "u=1, i",
        "sec-ch-ua": "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"",
        "sec-ch-ua-arch": "\"x86\"",
        "sec-ch-ua-bitness": "\"64\"",
        "sec-ch-ua-full-version-list": "\"Chromium\";v=\"140.0.0.0\", \"Not=A?Brand\";v=\"24.0.0.0\", \"Google Chrome\";v=\"140.0.0.0\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-model": "\"\"",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-ch-ua-platform-version": "\"10.0.0\"",
        "sec-ch-ua-wow64": "?0",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "same-origin",
        "sec-fetch-site": "same-origin",
        "sec-gpc": "1",
        "x-goog-authuser": "0",
        "x-goog-visitor-id": "",
        "x-origin": "https://www.youtube.com",
        "x-youtube-bootstrap-logged-in": "true",
        "x-youtube-client-name": "0",
        "x-youtube-client-version": "2.20250904.01.00"
      },
      "referrer": "https://www.youtube.com/results",
      "body": JSON.stringify({
        "context": {
          "client": {
            "hl": "en",
            "gl": "SV",
            "remoteHost": "",
            "deviceMake": "",
            "deviceModel": "",
            "visitorData": "",
            "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36,gzip(gfe)",
            "clientName": "WEB",
            "clientVersion": "2.20250904.01.00",
            "osName": "Windows",
            "osVersion": "10.0",
            "originalUrl": "",
            "platform": "DESKTOP",
            "clientFormFactor": "UNKNOWN_FORM_FACTOR",
            "configInfo": {
              "appInstallData": "",
              "coldConfigData": "",
              "coldHashData": "",
              "hotHashData": ""
            },
            "userInterfaceTheme": "USER_INTERFACE_THEME_DARK",
            "browserName": "Chrome",
            "browserVersion": "140.0.0.0",
            "acceptHeader": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "deviceExperimentId": "",
            "rolloutToken": "",
            "screenWidthPoints": 2560,
            "screenHeightPoints": 1329,
            "screenPixelDensity": 1,
            "screenDensityFloat": 1,
            "utcOffsetMinutes": 0,
            "memoryTotalKbytes": "4000000",
            "mainAppWebInfo": {
              "graftUrl": "/results",
              "pwaInstallabilityStatus": "PWA_INSTALLABILITY_STATUS_CAN_BE_INSTALLED",
              "webDisplayMode": "WEB_DISPLAY_MODE_BROWSER",
              "isWebNativeShareAvailable": true
            }
          },
          "user": {
            "lockedSafetyMode": false
          },
          "request": {
            "useSsl": true,
            "internalExperimentFlags": [],
            "consistencyTokenJars": []
          },
          "clickTracking": {
            "clickTrackingParams": ""
          },
          "adSignalsInfo": {
            "params": []
          }
        },
        "query": query,
        "webSearchboxStatsUrl": ""
      }),
      "method": "POST",
      "mode": "cors"
    });

    if (!response.ok) {
      throw new Error(`YouTube API request failed: ${response.status}`);
    }

    const data = await response.json();
    
    // Parse the response to extract video entries
    const entries = [];
    
    if (data.contents && data.contents.twoColumnSearchResultsRenderer && 
        data.contents.twoColumnSearchResultsRenderer.primaryContents && 
        data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer && 
        data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents) {
      
      const contents = data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
      
      for (const content of contents) {
        if (content.itemSectionRenderer && content.itemSectionRenderer.contents) {
          for (const item of content.itemSectionRenderer.contents) {
            if (item.videoRenderer) {
              const video = item.videoRenderer;
              
              // Extract video information
              const entry = {
                id: video.videoId,
                title: video.title && video.title.runs ? video.title.runs.map(run => run.text).join('') : '',
                uploader: video.ownerText && video.ownerText.runs ? video.ownerText.runs.map(run => run.text).join('') : 
                         (video.longBylineText && video.longBylineText.runs ? video.longBylineText.runs.map(run => run.text).join('') : ''),
                duration: video.lengthText ? parseDurationToSeconds(video.lengthText.simpleText) : null,
                webpage_url: `https://www.youtube.com/watch?v=${video.videoId}`,
                view_count: video.viewCountText ? video.viewCountText.simpleText : null,
                thumbnail: video.thumbnail && video.thumbnail.thumbnails && video.thumbnail.thumbnails.length > 0 ? 
                         video.thumbnail.thumbnails[0].url : null,
                raw: item
              };
              
              entries.push(entry);
              
              // Limit results
              if (entries.length >= limit) {
                break;
              }
            }
          }
        }
        
        if (entries.length >= limit) {
          break;
        }
      }
    }
    
    return entries;
    
  } catch (error) {
    console.error('[searchYouTubeAPI] Error:', error.message);
    throw error;
  }
}

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
        const entries = await searchYouTubeAPI(searchQuery, SERVER_CONSTANTS.LIMITS.DEFAULT_LIMIT);
        
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
            _score: item._score,
            raw: e.raw || null
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
