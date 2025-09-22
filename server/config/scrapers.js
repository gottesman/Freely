/**
 * Torrent Scrapers Module - Site-specific scraper definitions using TorrentSearchManager
 */

/**
 * Initialize all default scrapers with the provided manager
 * @param {TorrentSearchManager} manager - The torrent search manager instance
 */
function initializeScrapers(manager) {
  
  // The Pirate Bay
  manager.createAndRegisterScraper({
    id: 'tpb',
    name: 'The Pirate Bay',
    searchUrl: `https://tpb.party/search/{query}/{page}/99/100`,
    listSelector: '#searchResult tr:not(.header)',
    resultBuilder: ($, $el) => {
      let title = $el.find('td a').eq(1).text().trim();
      let url = $el.find('td a').eq(1).attr('href');
      return {
        title,
        url,
        magnetURI: $el.find('a[href^="magnet:"]').attr('href'),
        size: $el.find('td').eq(4).text().match(/([\d.]+.*[KMGT]i?B)/)?.[1] || '',
        seeders: parseInt($el.find('td').eq(5).text()) || 0,
        leechers: parseInt($el.find('td').eq(6).text()) || 0,
      };
    },
  });

  // 1337x
  manager.createAndRegisterScraper({
    id: '1337x',
    name: '1337x',
    add: false,
    searchUrl: ({ query, page }) => [
      `https://www.1337x.to/search/${query.replace(/\s+/g, '+')}/${page}/`,
      `https://1337x.st/search/${query.replace(/\s+/g, '+')}/${page}/`
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

  // KickassTorrents
  manager.createAndRegisterScraper({
    id: 'kickass',
    name: 'KickassTorrents',
    searchUrl: ({ query, page }) => [
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

  // TorrentGalaxy
  manager.createAndRegisterScraper({
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

  // magnetDL
  manager.createAndRegisterScraper({
    id: 'magnetdl-1',
    name: 'magnetDL',
    add: true,
    searchUrl: 'https://magnetdl.app/data.php?page=0&q={query}',
    responseType: 'htmlFragment',
    listSelector: 'tr',
    resultBuilder: ($, $el) => {
      return {
        title: $el.find('td').eq(1).text().trim(),
        url: $el.find('a[href^="magnet:"]').attr('href'),
        size: $el.find('td').eq(4).text().trim(),
        seeders: parseInt($el.find('td.s').text()) || 0,
        leechers: parseInt($el.find('td.l').text()) || 0,
      };
    },
    magnetSelector: 'a[href^="magnet:"]',
  });

  // Solid Torrents
  manager.createAndRegisterScraper({
    id: 'solidtorrents',
    name: 'Solid Torrents',
    searchUrl: ({ query, page }) => `https://solidtorrents.to/search?q=${encodeURIComponent(query)}&page=${page || 1}`,
    listSelector: 'li.search-result',
    resultBuilder: ($, $el, res) => {
      const $name = $el.find('.info h5 a').first();
      const title = $name.text().trim();
      const href = $name.attr('href');
      const url = href ? new URL(href, res.url).href : undefined;

      const magnetURI = $el.find('.links a.dl-magnet[href^="magnet:"]').attr('href');

      const $stats = $el.find('.stats div');
      // Based on plugin: column 2=size, 3=seeds, 4=leech
      const sizeRaw = ($stats.eq(1).text() || '').trim();
      const size = sizeRaw.replace(/\s+/g, ' ');
      const seeders = parseInt(($stats.eq(2).text() || '').replace(/[^\d]/g, ''), 10) || 0;
      const leechers = parseInt(($stats.eq(3).text() || '').replace(/[^\d]/g, ''), 10) || 0;

      return { title, url, magnetURI, size, seeders, leechers };
    },
    magnetSelector: '.links a.dl-magnet[href^="magnet:"]',
  });

  // torrent9
  manager.createAndRegisterScraper({
    id: 'torrent9',
    name: 'torrent9',
    // Use dynamic domains similar to the Python plugin that reads urls.json
    searchUrl: ({ query, page }) => [
      `https://www.torrent9.re/recherche/${encodeURIComponent(query)}`,
      `https://www.torrent9.fm/recherche/${encodeURIComponent(query)}`,
      `https://www.torrent9.nz/search_torrent/${encodeURIComponent(query)}/page-${page || 1}`,
      `https://torrent9.re/search_torrent/${encodeURIComponent(query)}/page-${page || 1}`
    ],
    listSelector: 'table tbody tr',
    resultBuilder: ($, $el, res) => {
      // Adapt based on common Torrent9 markup; prefer rows with a link in the first cell
      const $link = $el.find('td a').first();
      const detailPath = $link.attr('href');
      const sizeFr = $el.find('td').eq(1).text().trim();
      const normalizeFrUnit = (s) => s.replace(/([KMGTP])o/ig, '$1B');
      return {
        title: $link.text().trim(),
        url: detailPath ? new URL(detailPath, res.url).href : undefined,
        size: normalizeFrUnit(sizeFr),
        seeders: parseInt($el.find('td').eq(2).text()) || 0,
        leechers: parseInt($el.find('td').eq(3).text()) || 0,
      };
    },
    // Magnet is present on the detail page behind a red download button
    magnetSelector: ($$) => $$('a.btn.btn-danger[href^="magnet:"]').first().attr('href'),
  });

  manager.createAndRegisterScraper({
    id: 'limetorrents',
    name: 'LimeTorrents',
    searchUrl: ({ query, page }) => `https://www.limetorrents.info/search/all/${encodeURIComponent(query)}`,
    listSelector: 'table.table2 tbody tr:not(:first-of-type)',
    resultBuilder: ($, $el, res) => {
      console.log($el.html());
      const $name = $el.find('td .tt-name a').last();
      const title = $name.text().trim();
      const detailPath = $name.attr('href');
      const url = detailPath ? new URL(detailPath, res.url).href : undefined;
      const size = $el.find('td').eq(2).text().trim();
      const seeders = parseInt($el.find('td').eq(3).text()) || 0;
      const leechers = parseInt($el.find('td').eq(4).text()) || 0;
      return { title, url, size, seeders, leechers };
    },
    magnetSelector: 'a[href^="magnet:"]',
  });

  manager.createAndRegisterScraper({
    id: 'torrentdownload',
    name: 'TorrentDownload',
    searchUrl: ({ query, page }) => `https://www.torrentdownload.info/search?q=${encodeURIComponent(query)}&p=${page || 1}`,
    listSelector: 'table.table2:nth-of-type(2) tbody tr:not(:first-of-type)',
    resultBuilder: ($, $el, res) => {
      const $name = $el.find('td .tt-name a').first();
      const title = $name.text().trim();
      const url = $name.attr('href');
      return {
        title,
        url: url ? new URL(url, res.url).href : undefined,
        size: $el.find('td').eq(2).text().trim(),
        seeders: parseInt($el.find('td').eq(3).text()) || 0,
        leechers: parseInt($el.find('td').eq(4).text()) || 0,
      };
    },
    magnetSelector: 'a[href^="magnet:"]',
  });

  manager.createAndRegisterScraper({
    id: "bitsearch",
    name: "BitSearch",
    searchUrl: ({ query, page }) => `https://bitsearch.to/search?q=${encodeURIComponent(query)}&page=${page || 1}`,
    listSelector: 'div.space-y-4>div',
    resultBuilder: ($, $el, res) => {
      const $name = $el.find('h3').first();
      const title = $name.text().trim();
      const url = $name.attr('href');
      const magnetURI = $el.find('a[href^="magnet:"]').attr('href');
      const size = $el.find('span.inline-flex').eq(1).text().trim();
      const seeders = parseInt($el.find('span.inline-flex .font-medium').eq(0).text()) || 0;
      const leechers = parseInt($el.find('span.inline-flex .font-medium').eq(1).text()) || 0;
      return {
        title,
        url: url ? new URL(url, res.url).href : undefined,
        magnetURI,
        size,
        seeders,
        leechers };
    },
    magnetSelector: 'a[href^="magnet:"]',
  });

  // Rutracker (with login functionality)
  manager.createAndRegisterScraper({
    id: 'rutracker',
    name: 'Rutracker',
    add: false,
    data: {
      cookies: null,
      baseUrl: null,
      attempts: 0,
      maxAttempts: 3,
      lastLoginTs: 0
    },
    // Use selected baseUrl from login (mirror), fallback to common mirrors if not set
    searchUrl: ({ query, page, data }) => {
      const start = Math.max(0, ((page || 1) - 1) * 50);
      const q = encodeURIComponent(query);
      const base = data?.baseUrl;
      if (base) return `${base.replace(/\/$/, '')}/forum/tracker.php?nm=${q}&start=${start}`;
      return [
        `https://rutracker.org/forum/tracker.php?nm=${q}&start=${start}`,
        `https://rutracker.net/forum/tracker.php?nm=${q}&start=${start}`,
        `https://rutracker.nl/forum/tracker.php?nm=${q}&start=${start}`
      ];
    },
    fetchOptions: (data) => ({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
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
      const state = manager.registry.get('rutracker').data;
      // Avoid frequent relogin within 5 minutes
      if (state.cookies && (Date.now() - (state.lastLoginTs || 0) < 5 * 60 * 1000)) return true;
      if (state.attempts >= state.maxAttempts) {
        console.error('[rutracker] Max login attempts reached.');
        return false;
      }
      state.attempts++;
      console.log(`[rutracker] Performing login, attempt ${state.attempts}/${state.maxAttempts}`);

      const MIRRORS = [
        'https://rutracker.org',
        'https://rutracker.net',
        'https://rutracker.nl'
      ];

      const BROWSER_HEADERS = {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
      };

      const getSetCookie = (response) => {
        if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
        if (response.headers.raw?.()['set-cookie']) return response.headers.raw()['set-cookie'];
        const sc = response.headers.get('set-cookie');
        return sc ? sc.split(', ').filter(Boolean) : [];
      };

      const username = 'Gottesman';
      const password = '3dmen3d';
      const loginBody = `login_username=${encodeURIComponent(username)}&login_password=${encodeURIComponent(password)}&login=%D0%92%D1%85%D0%BE%D0%B4`;

      for (const mirror of MIRRORS) {
        try {
          const loginUrl = `${mirror}/forum/login.php`;
          // Preflight to get initial cookies
          const pre = await manager.fetchWithOpts(loginUrl, { headers: BROWSER_HEADERS, cache: 'no-store' });
          if (!pre.ok) throw new Error(`GET login page failed (${pre.status})`);
          const preCookies = getSetCookie(pre);
          const initialCookies = preCookies.map(c => c.split(';')[0]).join('; ');
          // POST credentials
          const post = await manager.fetchWithOpts(loginUrl, {
            method: 'POST',
            headers: {
              ...BROWSER_HEADERS,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Cookie': initialCookies,
              'Referer': loginUrl,
              'Origin': mirror
            },
            body: loginBody,
            cache: 'no-store'
          });
          if (!post.ok) throw new Error(`POST login failed (${post.status})`);
          const postCookies = getSetCookie(post).map(c => c.split(';')[0]);
          const hasSession = postCookies.some(c => /^bb_session=/.test(c));
          if (!hasSession) {
            const bodyPreview = (await post.text()).slice(0, 500);
            throw new Error(`Login did not set bb_session cookie. Preview: ${bodyPreview}`);
          }
          const finalCookies = postCookies.join('; ');
          manager.setScraperData('rutracker', {
            cookies: finalCookies,
            baseUrl: mirror,
            lastLoginTs: Date.now()
          });
          console.log(`[rutracker] Login successful on mirror: ${mirror}`);
          return true;
        } catch (e) {
          console.warn(`[rutracker] Mirror failed: ${mirror}: ${e.message}`);
          continue;
        }
      }

      manager.setScraperData('rutracker', { cookies: null });
      console.error('[rutracker] All mirrors failed for login');
      return false;
    },
  });

  // Snowfl (tokenized JSON API)
  {
    const snowfl = {
      id: 'snowfl',
      name: 'Snowfl',
      add: true,
      searchUrl: 'https://snowfl.com/',
      data: {
        token: null,
        tokenTs: 0,
        attempts: 0,
        maxAttempts: 3
      },
      // We'll still set a generic magnet selector for detail pages (fallback)
      magnetSelector: 'a[href^="magnet:"]'
    }

    const BASE = 'https://snowfl.com/';
    const DATA_TTL = 10 * 60 * 1000; // 10 minutes
    const BROWSER_HEADERS = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    };

    // Login = retrieve and cache token from site script, run on server start
    snowfl.login = async () => {
      try {
        const state = manager.registry.get('snowfl').data;
        // Use cached token if still fresh
        if (state.token && (Date.now() - (state.tokenTs || 0) < DATA_TTL)) return true;
        if (state.attempts >= state.maxAttempts) {
          console.error('[snowfl] Max token attempts reached');
          return false;
        }
        state.attempts++;

        const indexRes = await manager.fetchWithOpts(BASE + 'index.html', { headers: BROWSER_HEADERS });
        if (!indexRes.ok) throw new Error(`index fetch ${indexRes.status}`);
        const indexHtml = await indexRes.text();
        const jsMatch = indexHtml.match(/"(b\.min\.js\?[^\"]+)"/);
        if (!jsMatch) throw new Error('b.min.js ref not found');
        const jsUrl = new URL(jsMatch[1], BASE).href;

        const jsRes = await manager.fetchWithOpts(jsUrl, { headers: BROWSER_HEADERS });
        if (!jsRes.ok) throw new Error(`script fetch ${jsRes.status}`);
        const jsBody = await jsRes.text();
        let tokenMatch = jsBody.match(/"([A-Za-z0-9]+)";\$\(\(function\(\)\{var e,t,n,r,o,a,i=/);
        if (!tokenMatch) tokenMatch = jsBody.match(/"([A-Za-z0-9]{8,})";\$\(/);
        if (!tokenMatch) throw new Error('token not found');
        const token = tokenMatch[1];
        manager.setScraperData('snowfl', { token, tokenTs: Date.now(), attempts: 0 });
        console.log('[snowfl] Token acquired');
        return true;
      } catch (e) {
        console.warn('[snowfl] login failed:', e.message);
        return false;
      }
    };

    // Override search to implement token retrieval + JSON parsing
    snowfl.search = async ({ query, page = 1 }) => {
      const rnd = () => Math.random().toString(36).slice(2, 10);
      // Use cached token or refresh via login when missing/expired
      const sref = manager.registry.get('snowfl');
      const d = sref?.data || {};
      let token = d.token;
      if (!token || (Date.now() - (d.tokenTs || 0) >= DATA_TTL)) {
        await snowfl.login();
        token = manager.registry.get('snowfl')?.data?.token;
      }
      if (!token) throw new Error('snowfl token unavailable');
      const qPart = encodeURIComponent(query);
      const apiUrl = `${BASE}${token}/${qPart}/${rnd()}/0/SEED/NONE/1?_=${Date.now()}`;

      const res = await manager.fetchWithOpts(apiUrl, { headers: { ...BROWSER_HEADERS, 'Accept': 'application/json, text/plain, */*' } });
      if (!res.ok) {
        // Attempt one token refresh retry on 403/404
        if (res.status === 403 || res.status === 404) {
          manager.setScraperData('snowfl', { token: null, tokenTs: 0 });
          await snowfl.login();
          const fresh = manager.registry.get('snowfl')?.data?.token;
          const retryUrl = `${BASE}${fresh}/${qPart}/${rnd()}/0/SEED/NONE/1?_=${Date.now()}`;
          const retry = await manager.fetchWithOpts(retryUrl, { headers: { ...BROWSER_HEADERS, 'Accept': 'application/json, text/plain, */*' } });
          if (!retry.ok) throw new Error(`snowfl fetch failed (${retry.status})`);
          const retryJson = await retry.json().catch(async () => JSON.parse(await retry.text()));
          return Array.isArray(retryJson) ? retryJson.map(t => ({
            title: t?.name || '',
            url: t?.url,
            magnetURI: t?.magnet,
            size: t?.size || '',
            seeders: parseInt(t?.seeder) || 0,
            leechers: parseInt(t?.leecher) || 0
          })) : [];
        }
        throw new Error(`snowfl fetch failed (${res.status})`);
      }

      const json = await res.json().catch(async () => JSON.parse(await res.text()));
      if (!Array.isArray(json)) return [];
      return json.map(t => ({
        title: t?.name || '',
        url: t?.url,
        magnetURI: t?.magnet,
        size: t?.size || '',
        seeders: parseInt(t?.seeder) || 0,
        leechers: parseInt(t?.leecher) || 0
      }));
    };
    manager.createAndRegisterScraper(snowfl);
  }

  console.log(`[Scrapers] Initialized ${manager.registry.size} scrapers`);
}

module.exports = {
  initializeScrapers
};
