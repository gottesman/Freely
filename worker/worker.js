import {CORS_HEADERS, optionsResponse, handlers} from "handlers.js"

/**
 * Router: dispatch by first path segment
 */
export default {
  async fetch(request, env, ctx) {
    // quick OPTIONS at top-level
    if (request.method === 'OPTIONS') return optionsResponse();

    const url = new URL(request.url);
    const pathname = (url.pathname || '/').replace(/^\/+|\/+$/g, ''); // trim leading/trailing slashes
    const segments = pathname === '' ? [] : pathname.split('/');
    const first = segments[0] || '';
    const restPath = segments.slice(1).join('/');
    const params = { restPath, segments };

    // normalize ETag token for comparison (strip W/ and surrounding whitespace)
    const normalizeTag = (tag) => {
      if (!tag) return '';
      let t = tag.trim();
      if (t.startsWith('W/')) t = t.slice(2);
      return t;
    };

    // compare client If-None-Match header against our computed/current etag
    const etagMatches = (ifNoneMatchHeader, currentEtag) => {
      if (!ifNoneMatchHeader || !currentEtag) return false;
      const header = ifNoneMatchHeader.trim();
      if (header === '*') return true;
      const tokens = header.split(',').map(t => t.trim()).filter(Boolean);
      const normCurrent = normalizeTag(currentEtag);
      for (const tok of tokens) {
        if (normalizeTag(tok) === normCurrent) return true;
      }
      return false;
    };

    // For GET/HEAD, perform conditional 304 if client validators match cached resource.
    if (request.method === 'GET' || request.method === 'HEAD') {
      try {
        const cache = caches.default;

        // Derive cache-key candidate(s) from segments (inline, no external builders)
        // Try to reconstruct the exact keys your handlers used (kept inline here).
        // Fallback to request.url if nothing else matches.
        const candidates = [];

        // If the first segment exists, attempt to reconstruct likely upstream/internal cache keys.
        // This is inline and uses only `segments` (no separate builders object).
        if (segments.length > 0) {
          // Example: /genius/...  -> handler cached using upstream URL: https://api.genius.com/<rest><search>
          if (first === 'genius') {
            const upstreamBase = 'https://api.genius.com/';
            candidates.push(upstreamBase + (restPath ? restPath : '') + url.search);
          }

          // Example: /getTokenSpotify  -> handler cached with fixed internal key
          if (first === 'getTokenSpotify') {
            candidates.push('https://worker.internal/token');
          }

          // Generic candidate derived directly from the incoming request
          candidates.push(request.url);
        } else {
          // root path: just use the request url
          candidates.push(request.url);
        }

        // Try candidates in order until we find a cached entry
        let cached = null;
        let usedKey = null;
        for (const key of candidates) {
          try {
            const entry = await cache.match(new Request(key));
            if (entry) {
              cached = entry;
              usedKey = key;
              break;
            }
          } catch (e) {
            // ignore errors per-candidate and continue
          }
        }

        if (cached) {
          const clientIfNoneMatch = request.headers.get('If-None-Match');
          const clientIfModifiedSince = request.headers.get('If-Modified-Since');

          // Try to obtain ETag from cached headers or compute it lazily if client provided If-None-Match
          let etag = cached.headers.get('ETag') || null;
          if (!etag && clientIfNoneMatch) {
            try {
              const buf = await cached.clone().arrayBuffer();
              const digest = await crypto.subtle.digest('SHA-256', buf);
              const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
              etag = `"${hex}"`;
            } catch (e) {
              etag = null;
            }
          }

          // Try to get Last-Modified (if present)
          const lastModified = cached.headers.get('Last-Modified') || cached.headers.get('Date') || null;

          // If client provided If-None-Match, prefer ETag comparison
          if (clientIfNoneMatch && etag) {
            if (etagMatches(clientIfNoneMatch, etag)) {
              const headers = new Headers({ ...CORS_HEADERS });
              const cachedCc = cached.headers.get('Cache-Control');
              if (cachedCc) headers.set('Cache-Control', cachedCc);
              const cachedExpires = cached.headers.get('Expires');
              if (cachedExpires) headers.set('Expires', cachedExpires);
              headers.set('ETag', etag);
              // Optionally include a hint about which cache key matched (for debugging)
              headers.set('X-Cache-Key', usedKey);
              return new Response(null, { status: 304, headers });
            }
          } else if (clientIfModifiedSince && lastModified) {
            try {
              const clientDate = Date.parse(clientIfModifiedSince);
              const cachedDate = Date.parse(lastModified);
              if (!Number.isNaN(clientDate) && !Number.isNaN(cachedDate)) {
                // resource was NOT modified since client's date -> 304
                if (cachedDate <= clientDate) {
                  const headers = new Headers({ ...CORS_HEADERS });
                  const cachedCc = cached.headers.get('Cache-Control');
                  if (cachedCc) headers.set('Cache-Control', cachedCc);
                  const cachedExpires = cached.headers.get('Expires');
                  if (cachedExpires) headers.set('Expires', cachedExpires);
                  if (etag) headers.set('ETag', etag);
                  headers.set('Last-Modified', new Date(cachedDate).toUTCString());
                  headers.set('X-Cache-Key', usedKey);
                  return new Response(null, { status: 304, headers });
                }
              }
            } catch (e) {
              // parsing error — ignore and fall through to handler
            }
          }
          // If the client provided validators but they didn't match, fall through so handler can return fresh content.
          // If client provided no validators, also fall through (we only return 304 when client asks via validators).
        }
      } catch (err) {
        // If anything goes wrong with the conditional/cache check, ignore and continue to handler dispatch.
        console.warn('conditional-cache-check-error', String(err));
      }
    }

    // If no conditional 304 was returned, dispatch to the handler as before
    if (!first) {
      // index: list available paths
      const listing = {
        available: Object.keys(handlers),
        hint: 'Visit /<subdir>. For CORS preflight use OPTIONS.',
      };
      return new Response(JSON.stringify(listing, null, 2), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    const handler = handlers[first];
    if (!handler) {
      return new Response(JSON.stringify({ error: 'not_found', message: `No handler for '${first}'` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    try {
      return await handler(request, env, ctx, params);
    } catch (err) {
      return new Response(JSON.stringify({ error: 'handler_exception', message: String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }
  }
};
