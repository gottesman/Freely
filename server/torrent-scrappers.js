"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = {
            enumerable: true,
            get: function() {
                return m[k];
            }
        };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", {
        enumerable: true,
        value: v
    });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function() {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function(o) {
            var ar = [];
            for (var k in o)
                if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function(mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null)
            for (var k = ownKeys(mod), i = 0; i < k.length; i++)
                if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.createAndRegisterScraper = createAndRegisterScraper;
exports.listScrapers = listScrapers;
exports.searchAll = searchAll;
const cheerio = __importStar(require("cheerio"));

// --- CORE INFRASTRUCTURE ---

let _runtimeFetch = null;
async function _getFetch() {
    if (_runtimeFetch) return _runtimeFetch;
    if (typeof globalThis?.fetch === 'function') {
        _runtimeFetch = global.fetch.bind(globalThis);
        return _runtimeFetch;
    }
    const mod = await Promise.resolve().then(() => __importStar(require('node-fetch')));
    _runtimeFetch = mod.default || mod;
    return _runtimeFetch;
}

function setData(scraperId, data) {
    const scraper = registry.get(scraperId);
    if (scraper) scraper.data = {
        ...(scraper.data || {}),
        ...data
    };
}

function fetchWithOpts(url, init) {
    const defaultHeaders = {
        'User-Agent': 'freely/1.0'
    };
    const opts = {
        ...init,
        headers: {
            ...defaultHeaders,
            ...init?.headers
        }
    };
    return _getFetch().then((f) => f(url, opts));
}
async function tryFetchAny(urls, init, timeoutMs = 3000) {
    for (const url of Array.isArray(urls) ? urls : [urls]) {
        try {
            const res = await Promise.race([fetchWithOpts(url, init), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
            if (res?.ok) return res;
        } catch {}
    }
    return null;
}
async function fetchDetailMagnet(detailUrl, selector, options = {}) {
    if (!detailUrl) return undefined;
    try {
        const dres = await fetchWithOpts(detailUrl, options);
        if (!dres.ok) {
            console.error(`[fetchDetailMagnet] Failed to fetch ${detailUrl}, status: ${dres.status}`);
            return undefined;
        }
        const $$ = cheerio.load(await dres.text());
        if (typeof selector === 'function') return selector($$);
        if (typeof selector === 'string') return $$(selector).first().attr('href');
    } catch (err) {
        console.error(`[fetchDetailMagnet] A network or parsing error occurred for ${detailUrl}`, err);
    }
    return undefined;
}

function parseMagnet(magnet) {
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

function combineMagnets(magnets) {
    const parsed = magnets.map(parseMagnet).filter(Boolean);
    if (!parsed.length) return undefined;
    const xt = parsed[0].xt;
    const dn = parsed.find(p => p.dn)?.dn || '';
    const trackers = Array.from(new Set(parsed.flatMap(p => p.trackers)));
    let magnet = `magnet:?xt=${xt}`;
    if (dn) magnet += `&dn=${encodeURIComponent(dn)}`;
    for (const tr of trackers) magnet += `&tr=${encodeURIComponent(tr)}`;
    return magnet;
}

function setInfoHashFromMagnet(result) {
    if (!result || !result.magnetURI) return;
    const match = result.magnetURI.match(/xt=urn:btih:([a-fA-F0-9]{40})/);
    if (match && match[1]) result.infoHash = match[1].toLowerCase();
}

function setInfoForResult(result, magnet, query) {
    if (!result) return;
    if (magnet) {
        result.magnetURI = magnet;
        setInfoHashFromMagnet(result);
    }
    if (typeof result.seeders !== 'number') result.seeders = parseInt(String(result.seeders)) || 0;
    const q = (query && typeof query.query === 'string') ? query.query : String(query || '');
    try {
        result._score = calcScore(q, result.title || '', result.seeders || 0);
    } catch (e) {
        result._score = 0;
    }
}

function getInfoHash(result) {
    if (!result) return null;
    if (result.infoHash) return result.infoHash;
    if (result.magnetURI) {
        setInfoHashFromMagnet(result);
        return result.infoHash || null;
    }
    return null;
}
const registry = new Map();

function registerScraper(scraper) {
    registry.set(scraper.id, scraper);
    if (scraper.login && typeof scraper.login === 'function' && scraper.add) {
        scraper.login().then((res) => {
            console.log(`[scraper:${scraper.id}] login() executed with status: ${res ? 'success' : 'failure'}`);
        }).catch(err => {
            console.error(`[scraper:${scraper.id}] login() execution error:`, err);
        });
    }
}

function listScrapers() {
    return Array.from(registry.values()).map(s => ({
        id: s.id,
        name: s.name
    }));
}

function normalizeStr(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function getWords(s) {
    return (String(s || '').match(/[a-z0-9]+/g) || []);
}
const MIN_SCORE = 40;

function calcScore(query, title, seeds = 0) {
    const qNorm = normalizeStr(query);
    let qWords = getWords(qNorm);
    if (!qWords.length) {
        const alt = String(query || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
        qWords = (alt.match(/[a-z0-9]+/g) || []);
    }
    if (!qWords.length) return 0;
    const coreWords = qWords.filter(w => w.length > 3);
    const titleNorm = normalizeStr(title);
    const titleWords = new Set(getWords(titleNorm));
    const matchRatio = qWords.filter(w => titleWords.has(w)).length / qWords.length;
    const coreMatched = coreWords.length ? coreWords.filter(w => titleWords.has(w)).length / coreWords.length : matchRatio;
    const phraseMatch = titleNorm.includes(qNorm) ? 1 : 0;
    const base = (matchRatio * 0.7) + (coreMatched * 0.2) + (phraseMatch * 0.1);
    const seedFactor = Math.min(Math.log10(Math.max(1, seeds)) / 3, 1.0);
    const score = (base * 80) + (seedFactor * 20);
    return Math.round(score);
}

function dedupeMagnets(results) {
    const groups = new Map();
    for (const r of results) {
        const key = getInfoHash(r) || normalizeStr(r.title || '');
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
            const combined = combineMagnets(magnetsList);
            if (combined) best.magnetURI = combined;
        }
        deduped.push(best);
    }
    deduped.sort((a, b) => (b._score || 0) - (a._score || 0) || (b.seeders || 0) - (a.seeders || 0));
    return deduped;
}
async function searchAll(opts, timeoutMs = 3000) {
    const qRaw = String(opts?.query || '').trim();
    if (!qRaw || qRaw.toLowerCase() === 'ping') return [];
    const scrapersArr = Array.from(registry.values()).filter(s => s.add && typeof s.search === 'function');
    const scraperPromises = scrapersArr.map(s => s.search(opts).catch((err) => {
        console.error(`[searchAll] Scraper "${s.id}" failed:`, err.message);
        return [];
    }));
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({
        timeout: true
    }), timeoutMs));
    const allPromises = Promise.all(scraperPromises);
    const winner = await Promise.race([allPromises, timeoutPromise]);
    let flatResults;
    if (winner.timeout) {
        console.log(`Global search timeout of ${timeoutMs}ms exceeded. Processing results gathered so far.`);
        const settled = await Promise.allSettled(scraperPromises);
        flatResults = settled.filter(s => s.status === 'fulfilled').flatMap(s => s.value || []);
    } else {
        flatResults = winner.flatMap(arr => arr || []);
    }
    for (const r of flatResults) {
        setInfoForResult(r, r.magnetURI, qRaw);
    }
    let final = flatResults.filter(r => (r._score || 0) >= MIN_SCORE);
    if (!final.length && flatResults.length > 0) {
        final = flatResults.sort((a, b) => (b._score || 0) - (a._score || 0)).slice(0, 15);
    }
    return dedupeMagnets(final);
}

// --- CONTENT-TYPE FILTERING LOGIC ---

// Regex to identify common video-related terms in a torrent title.
const VIDEO_TERMS_REGEX = /\b(?:1080p|720p|2160p|4k|8k|480p|576p|1080i|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdtv|dvdrip|dvd-r|dvdr|x264|x265|h264|h265|hevc|hd|sd|cam|telesync|ts|xvid|divx|mkv|mp4|avi|movie|season|episode|s\d{1,2}e\d{1,2})\b/i;

// Regex to identify common audio-related terms, used to override the video filter.
const AUDIO_TERMS_REGEX = /\b(?:flac|alac|wav|ape|dsd|sacd|mp3|aac|ogg|opus|m4a|soundtrack|ost|album|discography|lp|ep|320k|v0|24bit|16bit|cd)\b/i;

/**
 * Determines if a result should be excluded based on its title and the desired filter.
 * The core logic: exclude if it looks like video, UNLESS it also explicitly looks like audio.
 * @param {TorrentResult} result The torrent result object.
 * @param {'video' | 'none'} excludeType The content type to exclude.
 * @returns {boolean} True if the result should be excluded, false otherwise.
 */
function isVideo(title) {
    const isVideo = VIDEO_TERMS_REGEX.test(title);
    const isAudio = AUDIO_TERMS_REGEX.test(title);

    // Exclude if it's a video UNLESS it's also clearly an audio release (e.g., Soundtrack, Music Video).
    return isVideo && !isAudio;
}

// --- SCRAPER FACTORY ---

function createAndRegisterScraper(definition) {
    const scraper = {
        id: definition.id,
        name: definition.name,
        add: definition.add ?? true,
        data: definition.data,
        login: definition.login,
        search: async (opts) => { // <-- Accept the full options object
            const { query, page = 1 } = opts;
            // ... (rest of the initial search logic is the same)
            let searchUrl;
            if (typeof definition.searchUrl === 'function') { searchUrl = definition.searchUrl({ query, page }); }
            else { searchUrl = definition.searchUrl.replace('{query}', encodeURIComponent(query)).replace('{page}', page); }
            const fetchOptions = definition.fetchOptions?.(registry.get(definition.id)?.data) || {};
            const res = await tryFetchAny(Array.isArray(searchUrl) ? searchUrl : [searchUrl], fetchOptions);
            if (!res) throw new Error(`${definition.name} fetch failed`);
            const body = await res.text();
            let $;
            if (definition.responseType === 'htmlFragment') { const wrappedBody = `<table><tbody>${body}</tbody></table>`; $ = cheerio.load(wrappedBody); }
            else { $ = cheerio.load(body); }

            const results = [];
            $(definition.listSelector).each((_, el) => {
                try {
                    const $el = $(el);
                    const partialResult = definition.resultBuilder($, $el, res);
                    if (!partialResult || !partialResult.title) return;
                    const result = { source: definition.name, ...partialResult };
                    setInfoForResult(result, result.magnetURI, query);
                    if(!isVideo(result.title)) results.push(result);
                } catch (e) {
                    console.error(`[${definition.id}] Error parsing a row`, e);
                }
            });
            
            if (definition.magnetSelector) {
                // MODIFIED: Apply content-type filter before creating fetch promises
                const detailFetches = results
                    .map(async (r) => {
                        const magnet = await fetchDetailMagnet(r.url, definition.magnetSelector, fetchOptions);
                        if (magnet) r.magnetURI = magnet;
                    });
                await Promise.all(detailFetches);
            }

            return results.filter(r => r.magnetURI);
        },
    };
    registerScraper(scraper);
}

// --- SCRAPER DEFINITIONS ---

createAndRegisterScraper({
    id: 'tpb',
    name: 'The Pirate Bay',
    searchUrl: `https://tpb.party/search/{query}/{page}/99/100`, /* the last 100 part is filter for audio */
    listSelector: '#searchResult tr:not(.header)',
    resultBuilder: ($, $el) => {
        let title = $el.find('.detName a').text().trim();
        let url = $el.find('.detName a').attr('href');
        if (!title) {
            const a = $el.find('td').eq(1).find('a').first();
            title = a.text().trim();
            url = url || a.attr('href');
        }
        return {
            title,
            url,
            magnetURI: $el.find('a[title="Download this torrent using magnet"]').attr('href'),
            size: $el.find('font.detDesc').text().match(/Size ([\d.]+.*[KMGT]i?B)/)?.[1] || '',
            seeders: parseInt($el.find('td').eq(2).text()) || 0,
            leechers: parseInt($el.find('td').eq(3).text()) || 0,
        };
    },
});

createAndRegisterScraper({
    id: '1337x',
    name: '1337x',
    add: false,
    searchUrl: ({query,page}) => [
        `https://www.1337x.to/search/${query.replace(/\s+/g,'+')}/${page}/`,
        `https://1337x.st/search/${query.replace(/\s+/g,'+')}/${page}/`
    ],
    listSelector: 'table.table-list tbody tr',
    resultBuilder: ($, $el, res) => {
        const detailPath = $el.find('td.coll-1 a').last().attr('href');
        return {
            title: $el.find('td.coll-1 a').last().text().trim(),
            url: detailPath ? new URL(detailPath, res.url).href : undefined,
            seeders: parseInt($el.find('td.coll-2').text()) || 0,
            leechers: parseInt($el.find('td.coll-3').text()) || 0,
            size: $el.find('td.coll-4').text().trim(),
        };
    },
    magnetSelector: 'a[href^="magnet:"]',
});

createAndRegisterScraper({
    id: 'kickass',
    name: 'KickassTorrents',
    searchUrl: ({query, page}) => [
        `https://kickasst.net/usearch/${encodeURIComponent(query)}%20category:music/`,
        `https://kickasstorrents.cc/search?query=${encodeURIComponent(query)}`,
    ],
    listSelector: 'table.data tr.odd, table.data tr.even',
    resultBuilder: ($, $el) => ({
        title: $el.find('a.cellMainLink').text().trim(),
        magnetURI: $el.find('a.imagnet').attr('href'),
        size: $el.find('td').eq(1).text().trim(),
        seeders: parseInt($el.find('td.green').text()) || 0,
        leechers: parseInt($el.find('td.red').text()) || 0,
    }),
});

createAndRegisterScraper({
    id: 'torrentgalaxy',
    name: 'TorrentGalaxy',
    searchUrl: `https://torrentgalaxy.hair/fullsearch?q={query}`,
    listSelector: '#torrents tr:not(.list-header)',
    resultBuilder: ($, $el, res) => {
        return {
            title: $el.find('.item-title a').text(),
            magnetURI: $el.find('a[href^="magnet:"]').attr('href'),
            size: $el.find('.item-size').text(),
            seeders: parseInt($el.find('.item-seed').text()) || 0,
            leechers: parseInt($el.find('.item-leech').text()) || 0,
        };
    },
    magnetSelector: 'a[href^="magnet:"]',
});

createAndRegisterScraper({
    id: 'magnetdl-1',
    name: 'magnetDL',
    add: true,
    searchUrl: 'https://magnetdl.app/data.php?page=1&q={query}',
    responseType: 'htmlFragment',
    listSelector: 'tr',
    resultBuilder: ($, $el) => {
        return {
            title: $el.find('td').eq(1).text().trim(),
            magnetURI: $el.find('a[href^="magnet:"]').attr('href'),
            size: $el.find('td').eq(4).text().trim(),
            seeders: parseInt($el.find('td.s').text()) || 0,
            leechers: parseInt($el.find('td.l').text()) || 0,
        };
    },
    magnetSelector: 'a[href^="magnet:"]',
});

createAndRegisterScraper({
    id: 'magnetdl-2',
    name: 'magnetDL',
    add: true,
    searchUrl: 'https://magnetdl.app/data.php?page=2&q={query}',
    responseType: 'htmlFragment',
    listSelector: 'tr',
    resultBuilder: ($, $el) => {
        return {
            title: $el.find('td').eq(1).text().trim(),
            magnetURI: $el.find('a[href^="magnet:"]').attr('href'),
            size: $el.find('td').eq(4).text().trim(),
            seeders: parseInt($el.find('td.s').text()) || 0,
            leechers: parseInt($el.find('td.l').text()) || 0,
        };
    },
    magnetSelector: 'a[href^="magnet:"]',
});

createAndRegisterScraper({
    id: 'magnetdl-3',
    name: 'magnetDL',
    add: true,
    searchUrl: 'https://magnetdl.app/data.php?page=3&q={query}',
    responseType: 'htmlFragment',
    listSelector: 'tr',
    resultBuilder: ($, $el) => {
        return {
            title: $el.find('td').eq(1).text().trim(),
            magnetURI: $el.find('a[href^="magnet:"]').attr('href'),
            size: $el.find('td').eq(4).text().trim(),
            seeders: parseInt($el.find('td.s').text()) || 0,
            leechers: parseInt($el.find('td.l').text()) || 0,
        };
    },
    magnetSelector: 'a[href^="magnet:"]',
});

createAndRegisterScraper({
    id: 'magnetdl-4',
    name: 'magnetDL',
    add: true,
    searchUrl: 'https://magnetdl.app/data.php?page=4&q={query}',
    responseType: 'htmlFragment',
    listSelector: 'tr',
    resultBuilder: ($, $el) => {
        return {
            title: $el.find('td').eq(1).text().trim(),
            magnetURI: $el.find('a[href^="magnet:"]').attr('href'),
            size: $el.find('td').eq(4).text().trim(),
            seeders: parseInt($el.find('td.s').text()) || 0,
            leechers: parseInt($el.find('td.l').text()) || 0,
        };
    },
    magnetSelector: 'a[href^="magnet:"]',
});

createAndRegisterScraper({
    id: 'torrent9',
    name: 'torrent9',
    searchUrl: `https://www.torrent9.re/recherche/{query}`,
    listSelector: 'table tbody tr',
    resultBuilder: ($, $el, res) => {
        const detailPath = $el.find('td a').attr('href');
        return {
            title: $el.find('td a').text().trim(),
            url: detailPath ? new URL(detailPath, res.url).href : undefined,
            size: $el.find('td').eq(1).text().trim(),
            seeders: parseInt($el.find('td').eq(2).text()) || 0,
            leechers: parseInt($el.find('td').eq(3).text()) || 0,
        };
    },
    magnetSelector: ($$) => $$('a.btn.btn-danger[href^="magnet:"]').first().attr('href'),
});

createAndRegisterScraper({
    id: 'rutracker',
    name: 'Rutracker',
    add: false,
    data: {
        cookies: null,
        attempts: 0,
        maxAttempts: 3
    },
    searchUrl: ({query,page}) => `https://rutracker.org/forum/tracker.php?nm=${encodeURIComponent(query)}&start=${(page - 1) * 50}`,
    fetchOptions: (data) => ({
        headers: {
            'Cookie': data?.cookies || ''
        }
    }),
    listSelector: 'tr.hl-tr',
    resultBuilder: ($, $el) => {
        const href = $el.find('a.torTopic').first().attr('href');
        return {
            title: $el.find('a.torTopic').first().text().trim(),
            url: href ? `https://rutracker.org/forum/${href}` : undefined,
            size: $el.find('td.tor-size').attr('data-ts_text'),
            seeders: parseInt($el.find('td.tor-seed b').text()) || 0,
            leechers: parseInt($el.find('td.tor-leech').text()) || 0,
        };
    },
    magnetSelector: 'a.magnet-link',
    login: async () => {
        const state = registry.get('rutracker').data;
        if (state.cookies) return true;
        if (state.attempts >= state.maxAttempts) {
            console.error('[rutracker] Max login attempts reached.');
            return false;
        }
        state.attempts++;
        console.log(`[rutracker] Performing login, attempt ${state.attempts}/${state.maxAttempts}`);
        try {
            const BROWSER_HEADERS = {
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
                "accept-language": "en-US,en;q=0.9",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            };
            const getSetCookie = (response) => {
                if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
                if (response.headers.raw?.()['set-cookie']) return response.headers.raw()['set-cookie'];
                return (response.headers.get('set-cookie') || '').split(', ').filter(Boolean);
            };
            const preLoginRes = await fetchWithOpts('https://rutracker.org/forum/login.php', {
                headers: BROWSER_HEADERS,
                cache: 'no-store'
            });
            if (!preLoginRes.ok) throw new Error(`Failed to GET login page, status=${preLoginRes.status}`);
            const preLoginCookies = getSetCookie(preLoginRes);
            if (!preLoginCookies.length) throw new Error('Did not receive initial session cookie. Anti-bot may be active.');
            const initialCookies = preLoginCookies.map(c => c.split(';')[0]).join('; ');
            const loginBody = 'login_username=Gottesman&login_password=3dmen3d&login=%C2%F5%EE%E4';
            const loginRes = await fetchWithOpts('https://rutracker.org/forum/login.php', {
                method: 'POST',
                headers: {
                    ...BROWSER_HEADERS,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': initialCookies,
                    'Referer': 'https://rutracker.org/forum/login.php',
                    'Origin': 'https://rutracker.org'
                },
                body: loginBody,
                cache: 'no-store'
            });
            if (!loginRes.ok) throw new Error(`Login POST failed, status=${loginRes.status}`);
            const finalCookiesArray = getSetCookie(loginRes);
            if (finalCookiesArray.length < 2) {
                throw new Error(`Login failed. Invalid credentials or anti-bot. Response preview: ${(await loginRes.text()).slice(0, 500)}`);
            }
            const finalCookies = finalCookiesArray.map(c => c.split(';')[0]).join('; ');
            setData('rutracker', {
                cookies: finalCookies
            });
            console.log('[rutracker] Successfully logged in.');
            return true;
        } catch (err) {
            console.error('[rutracker] Login error:', err.message);
            setData('rutracker', {
                cookies: null
            });
            return false;
        }
    },
});

exports.default = {
    registerScraper,
    listScrapers,
    searchAll,
    createAndRegisterScraper
};