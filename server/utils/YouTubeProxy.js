const http = require('http');
const https = require('https');
const { URL } = require('url');
const { SERVER_CONSTANTS } = require('../config/constants');

/**
 * YouTube proxy utilities for streaming
 */
class YouTubeProxy {
  
  /**
   * Proxy a YouTube CDN URL to response stream
   */
  static proxyUrl(urlStr, req, res, options = {}) {
    const { debug = false } = options;
    const tStart = Date.now();
    const PROXY_FIRST_BYTE_TIMEOUT = SERVER_CONSTANTS.TIMEOUTS.PROXY_FIRST_BYTE;
    
    return new Promise((resolve, reject) => {
      let parsed;
      try { 
        parsed = new URL(urlStr); 
      } catch (e) { 
        return reject(new Error('invalid-format-url')); 
      }

      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const headers = {
        'User-Agent': req.get('User-Agent') || 'node.js',
      };
      
      // Forward incoming Range header (if any) to upstream so CDN can honor seeks
      if (req.headers.range) {
        headers.Range = req.headers.range;
      }

      const opts = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        timeout: PROXY_FIRST_BYTE_TIMEOUT
      };

      if (debug) console.log('[YouTubeProxy] proxy opts', opts);

      // Guard to prevent double resolve/reject
      let settled = false;
      const doResolve = () => { 
        if (settled) return; 
        settled = true; 
        try { resolve(); } catch (_) {} 
      };
      const doReject = (err) => { 
        if (settled) return; 
        settled = true; 
        try { reject(err); } catch (_) {} 
      };

      const upstreamReq = lib.request(opts, upstreamRes => {
        // Copy status and headers (selectively)
        if (!res.headersSent) {
          res.statusCode = upstreamRes.statusCode || 200;
          
          // Copy content headers
          if (upstreamRes.headers['content-type']) {
            res.setHeader('Content-Type', upstreamRes.headers['content-type']);
          }
          if (upstreamRes.headers['content-length']) {
            res.setHeader('Content-Length', upstreamRes.headers['content-length']);
          }
          
          // Copy content-range if upstream provided it (important for ranged responses)
          if (upstreamRes.headers['content-range']) {
            res.setHeader('Content-Range', upstreamRes.headers['content-range']);
          }
          
          // Forward accept-ranges or other useful headers
          if (upstreamRes.headers['accept-ranges']) {
            res.setHeader('Accept-Ranges', upstreamRes.headers['accept-ranges']);
          }
        }

        // First-byte guard: if we don't get any 'data' event soon, kill request
        let first = false;
        const firstTimer = setTimeout(() => {
          if (!first) {
            if (debug) console.warn('[YouTubeProxy] proxy first-byte timeout, aborting upstream request');
            try { upstreamReq.abort(); } catch (_) { 
              try { upstreamReq.destroy(); } catch (_) {} 
            }
            doReject(new Error('proxy-first-byte-timeout'));
          }
        }, PROXY_FIRST_BYTE_TIMEOUT);

        upstreamRes.on('data', chunk => {
          if (!first) {
            first = true;
            clearTimeout(firstTimer);
            if (debug) console.log('[YouTubeProxy] first-byte from CDN after', Date.now() - tStart, 'ms');
          }
        });

        upstreamRes.on('end', () => {
          clearTimeout(firstTimer);
        });

        upstreamRes.on('close', () => {
          clearTimeout(firstTimer);
          if (debug) console.warn('[YouTubeProxy] upstreamRes closed');
          if (!first) {
            doReject(new Error('upstream-closed-before-first-byte'));
          }
        });

        upstreamRes.on('error', err => {
          clearTimeout(firstTimer);
          if (debug) console.error('[YouTubeProxy] upstreamRes error', err?.message || err);
          doReject(err);
        });

        upstreamRes.pipe(res).on('finish', () => {
          clearTimeout(firstTimer);
          if (debug) console.log('[YouTubeProxy] proxy finished');
          doResolve();
        }).on('error', err => {
          clearTimeout(firstTimer);
          if (debug) console.error('[YouTubeProxy] proxy stream error', err?.message || err);
          doReject(err);
        });
      });

      upstreamReq.on('timeout', () => {
        if (debug) console.warn('[YouTubeProxy] upstream request socket timeout');
        try { upstreamReq.abort(); } catch (_) { 
          try { upstreamReq.destroy(); } catch (_) {} 
        }
        doReject(new Error('upstream-timeout'));
      });

      upstreamReq.on('error', (err) => {
        if (debug) console.error('[YouTubeProxy] upstream request error', err?.message || err);
        doReject(err);
      });

      // If client disconnects, abort the upstream request and reject
      req.on('close', () => {
        if (debug) console.log('[YouTubeProxy] client disconnected, aborting upstream request');
        try { upstreamReq.abort(); } catch (_) { 
          try { upstreamReq.destroy(); } catch (_) {} 
        }
        doReject(new Error('client-disconnected'));
      });

      upstreamReq.end();
    });
  }
}

module.exports = YouTubeProxy;
