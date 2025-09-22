/**
 * Torrent Search Manager - Handles torrent scraping and search operations
 */
const cheerio = require('cheerio');

class TorrentSearchManager {
  constructor() {
    this.registry = new Map();
    this._runtimeFetch = null;
    this.MIN_SCORE = 1;
    this.initializeScrapers();
  }

  // --- CORE INFRASTRUCTURE ---

  async _getFetch() {
    if (this._runtimeFetch) return this._runtimeFetch;
    if (typeof globalThis?.fetch === 'function') {
      this._runtimeFetch = globalThis.fetch.bind(globalThis);
      return this._runtimeFetch;
    }
    const mod = await import('node-fetch');
    this._runtimeFetch = mod.default || mod;
    return this._runtimeFetch;
  }

  setScraperData(scraperId, data) {
    const scraper = this.registry.get(scraperId);
    if (scraper) {
      scraper.data = { ...(scraper.data || {}), ...data };
    }
  }

  async fetchWithOpts(url, init = {}) {
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    const fetch = await this._getFetch();
    const maxRedirects = typeof init.maxRedirects === 'number' ? init.maxRedirects : 5;
    let redirects = 0;
    let currentUrl = url;
    let method = init.method || 'GET';
    let body = init.body;
    let headersBase = { ...defaultHeaders, ...(init.headers || {}) };
    let cookies = headersBase.Cookie || headersBase.cookie;
    let lastOrigin;

    const getSetCookie = (response) => {
      if (!response || !response.headers) return [];
      if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
      if (response.headers.raw?.()['set-cookie']) return response.headers.raw()['set-cookie'];
      const sc = response.headers.get && response.headers.get('set-cookie');
      return sc ? sc.split(', ').filter(Boolean) : [];
    };

    while (true) {
      let sendHeaders = { ...headersBase };
      // Propagate Referer across redirects
      if (lastOrigin && !sendHeaders.Referer && !sendHeaders.referer) sendHeaders.Referer = lastOrigin + '/';
      if (cookies && !sendHeaders.Cookie) sendHeaders.Cookie = cookies;

      // Always request manual redirects so we can enforce a max
      const sendInit = {
        ...init,
        method,
        body,
        redirect: 'manual',
        headers: sendHeaders
      };

      const res = await fetch(currentUrl, sendInit);
      // Non-redirect or no location header: return
      const status = res.status;
      const loc = res.headers.get('location') || res.headers.get('Location');
      if (!(status >= 300 && status < 400 && loc)) {
        return res;
      }

      // Update cookies from redirect response
      try {
        const setCookies = getSetCookie(res);
        if (setCookies && setCookies.length) {
          const newCookie = setCookies.map(c => c.split(';')[0]).join('; ');
          cookies = cookies ? `${cookies}; ${newCookie}` : newCookie;
        }
      } catch {}

      redirects += 1;
      if (redirects > maxRedirects) {
        throw new Error(`Too many redirects (>${maxRedirects}) for ${url}`);
      }

      // Compute next URL
      let nextUrl;
      try { nextUrl = new URL(loc, currentUrl).href; } catch { nextUrl = loc; }
      try { const u = new URL(currentUrl); lastOrigin = u.origin; } catch {}

      // Per spec: 303 -> GET; 301/302 with non-GET/HEAD -> GET; 307/308 preserve method and body
      if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
        // Remove content-related headers on method change
        delete headersBase['Content-Type'];
        delete headersBase['content-type'];
        delete headersBase['Content-Length'];
        delete headersBase['content-length'];
      }

      currentUrl = nextUrl;
    }
  }

  async tryFetchAny(urls, init = {}, timeoutMs = 3000) {
    for (const url of Array.isArray(urls) ? urls : [urls]) {
      try {
        const res = await Promise.race([
          this.fetchWithOpts(url, init),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
        ]);
        if (res?.ok) return res;
      } catch { }
    }
    return null;
  }

  async fetchDetailMagnet(detailUrl, selector, options = {}) {
    if (!detailUrl) return undefined;
    try {
      // Apply browser-like headers by default to avoid simplistic bot blocks
      const browserDefaults = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate'
      };
      let referer;
      try { const u = new URL(detailUrl); referer = u.origin + '/'; } catch {}
      const mergedOpts = {
        ...options,
        headers: { ...browserDefaults, ...(options.headers || {}), ...(referer && !options?.headers?.Referer ? { Referer: referer } : {}) }
      };

      let dres = await this.fetchWithOpts(detailUrl, mergedOpts);
      // Retry once on common transient statuses
      if (!dres.ok && [403, 429, 503].includes(dres.status)) {
        await new Promise(r => setTimeout(r, 350));
        let retryOpts = { ...mergedOpts, headers: { ...mergedOpts.headers, 'Cache-Control': 'no-cache' } };
        // Preflight: fetch site origin to capture cookies if any, then retry with Cookie header
        try {
          const u = new URL(detailUrl);
          const home = u.origin + '/';
          const pre = await this.fetchWithOpts(home, { headers: browserDefaults, cache: 'no-store' });
          const getSetCookie = (response) => {
            if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
            if (response.headers.raw?.()['set-cookie']) return response.headers.raw()['set-cookie'];
            const sc = response.headers.get('set-cookie');
            return sc ? sc.split(', ').filter(Boolean) : [];
          };
          const sc = getSetCookie(pre);
          if (sc && sc.length) {
            const cookieHeader = sc.map(c => c.split(';')[0]).join('; ');
            retryOpts.headers = { ...retryOpts.headers, Cookie: cookieHeader };
          }
        } catch {}
        dres = await this.fetchWithOpts(detailUrl, retryOpts);
      }
      if (!dres.ok) {
        console.error(`[fetchDetailMagnet] Failed to fetch ${detailUrl}, status: ${dres.status}`);
        return undefined;
      }
      const $$ = cheerio.load(await dres.text());
      if (typeof selector === 'function') return selector($$);
      if (typeof selector === 'string') return $$(selector).first().attr('href');
    } catch (err) {
      console.error(`[fetchDetailMagnet] Error for ${detailUrl}`, err);
    }
    return undefined;
  }

  parseMagnet(magnet) {
    try {
      const url = new URL(magnet);
      const xt = url.searchParams.get('xt');
      if (!xt) return null;
      return {
        xt,
        dn: url.searchParams.get('dn'),
        trackers: url.searchParams.getAll('tr')
      };
    } catch {
      return null;
    }
  }

  combineMagnets(magnets) {
    const parsed = magnets.map(m => this.parseMagnet(m)).filter(Boolean);
    if (!parsed.length) return undefined;
    const xt = parsed[0].xt;
    const dn = parsed.find(p => p.dn)?.dn || '';
    const trackers = Array.from(new Set(parsed.flatMap(p => p.trackers)));
    let magnet = `magnet:?xt=${xt}`;
    if (dn) magnet += `&dn=${encodeURIComponent(dn)}`;
    for (const tr of trackers) magnet += `&tr=${encodeURIComponent(tr)}`;
    return magnet;
  }

  createMagnetFromInfoHash(infoHash, displayName = '') {
    const ih = String(infoHash || '').trim();
    if (!/^[A-Fa-f0-9]{40}$/.test(ih)) return undefined;
    let magnet = `magnet:?xt=urn:btih:${ih.toUpperCase()}`;
    if (displayName) magnet += `&dn=${encodeURIComponent(displayName)}`;
    // Add a small tracker set to improve discovery when sources don't provide any
    const trackers = [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://open.stealth.si:80/announce',
      'udp://tracker.torrent.eu.org:451/announce',
      'udp://exodus.desync.com:6969/announce'
    ];
    for (const tr of trackers) magnet += `&tr=${encodeURIComponent(tr)}`;
    return magnet;
  }

  setInfoHashFromMagnet(result) {
    if (!result || !result.magnetURI) return;
    const match = result.magnetURI.match(/xt=urn:btih:([a-fA-F0-9]{40})/);
    if (match && match[1]) result.infoHash = match[1].toLowerCase();
  }

  getInfoHash(result) {
    if (!result) return null;
    if (result.infoHash) return result.infoHash;
    if (result.magnetURI) {
      this.setInfoHashFromMagnet(result);
      return result.infoHash || null;
    }
    return null;
  }

  normalizeStr(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  getWords(s) {
    return (String(s || '').match(/[a-z0-9]+/g) || []);
  }

  levenshtein(a, b) {
    a = String(a || '');
    b = String(b || '');
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const v0 = new Array(n + 1), v1 = new Array(n + 1);
    for (let j = 0; j <= n; j++) v0[j] = j;
    for (let i = 0; i < m; i++) {
      v1[0] = i + 1;
      for (let j = 0; j < n; j++) {
        const cost = a[i] === b[j] ? 0 : 1;
        v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
      }
      for (let j = 0; j <= n; j++) v0[j] = v1[j];
    }
    return v1[n];
  }

  fuzzyRatio(a, b) {
    a = this.normalizeStr(a);
    b = this.normalizeStr(b);
    if (!a || !b) return 0;
    const dist = this.levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - (dist / maxLen);
  }

  contentTypePenalty(title) {
    const VIDEO_TERMS_REGEX = /\b(?:1080p|720p|2160p|4k|8k|480p|576p|1080i|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdtv|dvdrip|dvd-r|dvdr|x264|x265|h264|h265|hevc|hd|sd|cam|telesync|ts|xvid|divx|mkv|mp4|avi|movie|season|episode|s\d{1,2}e\d{1,2})\b/i;
    const AUDIO_TERMS_REGEX = /\b(?:flac|alac|wav|ape|dsd|sacd|mp3|aac|ogg|opus|m4a|soundtrack|ost|album|discography|lp|ep|320k|v0|24bit|16bit|cd)\b/i;

    const t = String(title || '');
    const isVideo = VIDEO_TERMS_REGEX.test(t);
    const isAudio = AUDIO_TERMS_REGEX.test(t);

    if (isAudio) return 0;
    if (isVideo) {
      if (/\b(?:cam|telesync|ts|telecine|camrip)\b/i.test(t)) return 12;
      if (/\b(?:bluray|bdrip|brrip|web-dl|webdl|hdtv|dvd|dvdrip)\b/i.test(t)) return 18;
      return 15;
    }
    return 0;
  }

  calcScore(query, title, seeds = 0) {
    const qRaw = String(query || '');
    const qNorm = this.normalizeStr(qRaw);
    let qWords = this.getWords(qNorm);
    if (!qWords.length) {
      const alt = String(query || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
      qWords = (alt.match(/[a-z0-9]+/g) || []);
    }
    if (!qWords.length) return 0;

    const coreWords = qWords.filter(w => w.length > 3);
    const titleNorm = this.normalizeStr(title || '');
    const titleWordsArr = this.getWords(titleNorm);
    const titleWords = new Set(titleWordsArr);

    const matchRatio = qWords.filter(w => titleWords.has(w)).length / qWords.length;
    const coreMatched = coreWords.length ? (coreWords.filter(w => titleWords.has(w)).length / coreWords.length) : matchRatio;
    const phraseMatch = titleNorm.includes(qNorm) ? 1 : 0;
    const yearMatch = (() => {
      const y = (qRaw.match(/\b(19|20)\d{2}\b/) || [null])[0];
      if (!y) return 0;
      return (titleNorm.includes(y) ? 1 : 0);
    })();
    const fuzz = this.fuzzyRatio(qRaw, title);
    const seedFactor = Math.min(Math.log10(Math.max(1, seeds)) / 3, 1.0);
    const base = (matchRatio * 0.55) + (coreMatched * 0.25) + (phraseMatch * 0.1) + (yearMatch * 0.05);
    const fuzzBoost = Math.max(0, (fuzz - 0.75)) * 0.5;
    const score = (base + fuzzBoost) * 80 + (seedFactor * 20);
    return Math.round(score);
  }

  setInfoForResult(result, magnet, query) {
    if (!result) return;
    if (magnet) {
      result.magnetURI = magnet;
      this.setInfoHashFromMagnet(result);
    }
    if (typeof result.seeders !== 'number') result.seeders = parseInt(String(result.seeders)) || 0;
    const q = (query && typeof query.query === 'string') ? query.query : String(query || '');
    try {
      result._score = this.calcScore(q, result.title || '', result.seeders || 0);
    } catch (e) {
      result._score = 0;
    }
  }

  dedupeMagnets(results) {
    const groups = new Map();
    for (const r of results) {
      const key = this.getInfoHash(r) || this.normalizeStr(r.title || '');
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const deduped = [];
    for (const group of groups.values()) {
      if (!group.length) continue;
      group.sort((a, b) => (b._score || 0) - (a._score || 0) || (b.seeders || 0) - (a.seeders || 0));
      const best = group[0];
      const magnetsList = group.map(g => g.magnetURI).filter(Boolean);
      if (magnetsList.length > 1) {
        const combined = this.combineMagnets(magnetsList);
        if (combined) best.magnetURI = combined;
      }
      deduped.push(best);
    }
    deduped.sort((a, b) => (b._score || 0) - (a._score || 0) || (b.seeders || 0) - (a.seeders || 0));
    return deduped;
  }

  buildQueryVariants({ title, artist }) {
    const baseTitle = (title || '').trim();
    const baseArtist = (artist || '').trim();
    const raw = (baseTitle && baseArtist) ? `${baseTitle} ${baseArtist}` : (baseTitle || baseArtist || '').trim();

    const variants = new Set();
    if (raw) variants.add(raw);
    if (baseTitle && baseArtist) variants.add(`${baseTitle} ${baseArtist}`);
    if (baseTitle) variants.add(baseTitle);
    if (baseArtist) variants.add(`${baseArtist} ${baseTitle}`);
    if (!/soundtrack|original soundtrack|ost/i.test(baseTitle)) {
      if (baseTitle && baseArtist) variants.add(`${baseTitle} soundtrack ${baseArtist}`);
      if (baseTitle && baseArtist) variants.add(`${baseTitle} original soundtrack ${baseArtist}`);
    }
    if (raw) variants.add(raw.replace(/\(.*?\)/g, '').trim());
    return Array.from(variants).filter(v => v.length > 0).slice(0, 6);
  }

  /**
   * Register a scraper with the manager
   */
  registerScraper(scraper) {
    this.registry.set(scraper.id, scraper);
    
    // Auto-login if scraper supports it
    if (scraper.login && typeof scraper.login === 'function' && scraper.add !== false) {
      scraper.login().then((res) => {
        console.log(`[TorrentSearchManager] ${scraper.id} login: ${res ? 'success' : 'failure'}`);
      }).catch(err => {
        console.error(`[TorrentSearchManager] ${scraper.id} login error:`, err.message);
      });
    }
  }

  /**
   * List all registered scrapers
   */
  listScrapers() {
    return Array.from(this.registry.values()).map(s => ({
      id: s.id,
      name: s.name,
      enabled: s.add !== false
    }));
  }

  /**
   * Search across all enabled scrapers with enhanced functionality
   */
  async searchAll(opts = {}, timeoutMs = 3000) {
    const title = opts?.title;
    const artist = opts?.artist;

    const variants = this.buildQueryVariants({ title, artist });
    const scrapersArr = Array.from(this.registry.values()).filter(s => s.add && typeof s.search === 'function');

    const scraperTasks = [];
    for (const s of scrapersArr) {
      for (const qVariant of variants) {
        scraperTasks.push(
          s.search({ query: qVariant, page: 1 })
            .then(results => ({ scraper: s, query: qVariant, results }))
            .catch(err => {
              console.error(`[TorrentSearchManager] Scraper "${s.id}" failed for query "${qVariant}":`, err?.message ?? err);
              return { scraper: s, query: qVariant, results: [] };
            })
        );
      }
    }

    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), timeoutMs));
    const allPromise = Promise.all(scraperTasks);
    const winner = await Promise.race([allPromise, timeoutPromise]);

    let collectedPartialResults = [];
    if (winner.timeout) {
      console.log(`Global search timeout of ${timeoutMs}ms exceeded. Processing results gathered so far.`);
      const settled = await Promise.allSettled(scraperTasks);
      const fulfilled = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
      for (const item of fulfilled) {
        const { scraper, query, results } = item;
        for (const r of results) {
          r._queryVariant = query;
          r._scraper = scraper;
        }
        collectedPartialResults.push(...(results || []));
      }
    } else {
      const winnerResults = winner;
      for (const item of winnerResults) {
        const { scraper, query, results } = item;
        for (const r of results) {
          r._queryVariant = query;
          r._scraper = scraper;
        }
        collectedPartialResults.push(...(results || []));
      }
    }

    // Create combined query for scoring
    const combinedQuery = title && artist ? `${title} ${artist}` : (title || artist || '');

    // Provisional scoring
    for (const r of collectedPartialResults) {
      this.setInfoForResult(r, undefined, r._queryVariant || combinedQuery);
    }

    // Select candidates for detail magnet fetch
    let magnetCandidates = collectedPartialResults.filter(r => (r._score || 0) >= this.MIN_SCORE);

    if (!magnetCandidates.length) {
      const topK = Math.min(15, Math.max(5, Math.round(collectedPartialResults.length * 0.25)));
      magnetCandidates = collectedPartialResults
        .slice()
        .sort((a,b) => (b._score||0) - (a._score||0))
        .slice(0, topK);
    }

    // Fetch magnets for selected candidates
    const detailFetchPromises = magnetCandidates.map(async r => {
      try {
        const scraper = r._scraper;
        const def = scraper?.definition;
        
        // Only fetch detail magnet if we don't already have one and it's not already a magnet URI
        if (!r.magnetURI && r.url && !r.url.startsWith('magnet:')) {
          // Fast path: derive magnet from URL if it contains a 40-hex infohash (e.g., torrentdownload.info/<INFOHASH>/...)
          const ihMatch = String(r.url).match(/\b([A-Fa-f0-9]{40})\b/);
          if (ihMatch && ihMatch[1]) {
            const derived = this.createMagnetFromInfoHash(ihMatch[1], r.title || '');
            if (derived) {
              r.magnetURI = derived;
            }
          }
          // Fallback to detail fetch if still no magnet and a selector is provided
          if (!r.magnetURI && def?.magnetSelector) {
            const fetchOptions = def?.fetchOptions?.(this.registry.get(scraper.id)?.data) || {};
            const magnet = await this.fetchDetailMagnet(r.url, def.magnetSelector, fetchOptions);
            if (magnet) r.magnetURI = magnet;
          }
        }
        
        this.setInfoForResult(r, r.magnetURI, r._queryVariant || combinedQuery);
        const penalty = this.contentTypePenalty(r.title || '');
        r._score = Math.max(0, (r._score || 0) - penalty);
      } catch (err) {
        console.error('[TorrentSearchManager] detailFetch error', err);
      }
      return r;
    });

    await Promise.all(detailFetchPromises);

    let final = collectedPartialResults.filter(r => (r._score || 0) >= this.MIN_SCORE && r.magnetURI);

    if (!final.length) {
      final = magnetCandidates.filter(r => r.magnetURI).sort((a,b) => (b._score||0) - (a._score||0)).slice(0, 15);
    }

    return this.dedupeMagnets(final);
  }

  /**
   * Score and sort search results
   */
  scoreResults(results, searchTerms) {
    const { query = '', title = '', artist = '' } = searchTerms;
    
    return results.map(torrent => {
      let score = 0;
      const torrentTitle = String(torrent.title || '').toLowerCase();
      const torrentArtist = String(torrent.artist || '').toLowerCase();
      
      // Basic text matching scoring
      if (query) {
        const queryLower = query.toLowerCase();
        if (torrentTitle.includes(queryLower)) score += 10;
        if (torrentArtist.includes(queryLower)) score += 8;
      }
      
      if (title) {
        const titleLower = title.toLowerCase();
        if (torrentTitle.includes(titleLower)) score += 15;
      }
      
      if (artist) {
        const artistLower = artist.toLowerCase();
        if (torrentArtist.includes(artistLower)) score += 12;
      }

      // Boost for seeders
      if (torrent.seeders && torrent.seeders > 0) {
        score += Math.min(torrent.seeders * 0.1, 10);
      }

      // Audio format bonus
      if (this.isAudioContent(torrentTitle)) {
        score += 5;
      }

      // Video format penalty for music searches
      if (this.isVideoContent(torrentTitle) && !this.isAudioContent(torrentTitle)) {
        score -= 8;
      }

      return { ...torrent, _score: score };
    }).sort((a, b) => (b._score || 0) - (a._score || 0));
  }

  /**
   * Extract info hash from magnet link
   */
  extractInfoHash(magnetLink) {
    if (!magnetLink || typeof magnetLink !== 'string') return null;
    
    const match = magnetLink.match(/[?&]xt=urn:btih:([a-fA-F0-9]{40})/);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Check if content appears to be audio-related
   */
  isAudioContent(title) {
    const audioTerms = /\b(?:flac|alac|wav|ape|dsd|sacd|mp3|aac|ogg|opus|m4a|soundtrack|ost|album|discography|lp|ep|320k|v0|24bit|16bit|cd)\b/i;
    return audioTerms.test(title);
  }

  /**
   * Check if content appears to be video-related
   */
  isVideoContent(title) {
    const videoTerms = /\b(?:1080p|720p|2160p|4k|8k|480p|576p|1080i|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdtv|dvdrip|x264|x265|h264|h265|hevc|mkv|mp4|avi|movie|season|episode|s\d{1,2}e\d{1,2})\b/i;
    return videoTerms.test(title);
  }

  /**
   * Create and register a scraper
   */
  createAndRegisterScraper(definition) {
    const scraper = {
      id: definition.id,
      name: definition.name,
      add: definition.add ?? true,
      data: definition.data,
      definition,
      login: definition.login,
      search: async (opts) => {
        const { query, page = 1 } = opts;
        let searchUrl;
        if (typeof definition.searchUrl === 'function') {
          // Pass scraper data so searchUrl can leverage cookies/baseUrl, etc.
          const sdata = this.registry.get(definition.id)?.data;
          searchUrl = definition.searchUrl({ query, page, data: sdata });
        } else {
          searchUrl = definition.searchUrl.replace('{query}', encodeURIComponent(query)).replace('{page}', page);
        }
        const fetchOptions = definition.fetchOptions?.(this.registry.get(definition.id)?.data) || {};
        // Enrich fetchOptions with a reasonable Referer when single URL is used
        let urls = Array.isArray(searchUrl) ? searchUrl : [searchUrl];
        const firstUrl = urls[0];
        if (firstUrl) {
          try {
            const u = new URL(firstUrl);
            fetchOptions.headers = { ...(fetchOptions.headers || {}), Referer: u.origin + '/' };
          } catch {}
        }
        const res = await this.tryFetchAny(urls, fetchOptions);
        if (!res) throw new Error(`${definition.name} (${firstUrl}) fetch failed: ${res ? res.status : 'no response'}`);
        const body = await res.text();
        let $;
        if (definition.responseType === 'htmlFragment') {
          const wrappedBody = `<table><tbody>${body}</tbody></table>`;
          $ = cheerio.load(wrappedBody);
        } else {
          $ = cheerio.load(body);
        }

        const partials = [];
        $(definition.listSelector).each((_, el) => {
          try {
            const $el = $(el);
            const partialResult = definition.resultBuilder($, $el, res);
            if (!partialResult || !partialResult.title) return;
            const result = { source: definition.name, ...partialResult };
            partials.push(result);
          } catch (e) {
            console.error(`[${definition.id}] Error parsing a row`, e);
          }
        });

        return partials;
      }
    };
    
    this.registerScraper(scraper);
    return scraper;
  }

  /**
   * Initialize default scrapers
   */
  initializeScrapers() {
    console.log('[TorrentSearchManager] Initializing scrapers...');
    
    // Load scrapers from external module
    try {
      const scrapers = require('../config/scrapers');
      if (scrapers && typeof scrapers.initializeScrapers === 'function') {
        scrapers.initializeScrapers(this);
        console.log('[TorrentSearchManager] Default scrapers loaded successfully');
      }
    } catch (err) {
      console.log('[TorrentSearchManager] No external scrapers module found, continuing without default scrapers');
    }
    
    console.log(`[TorrentSearchManager] Ready with ${this.registry.size} scrapers`);
  }
}

module.exports = TorrentSearchManager;
