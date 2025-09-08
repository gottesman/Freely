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

  // torrent9
  manager.createAndRegisterScraper({
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

  // Rutracker (with login functionality)
  manager.createAndRegisterScraper({
    id: 'rutracker',
    name: 'Rutracker',
    add: false,
    data: {
      cookies: null,
      attempts: 0,
      maxAttempts: 3
    },
    searchUrl: ({ query, page }) => `https://rutracker.org/forum/tracker.php?nm=${encodeURIComponent(query)}&start=${(page - 1) * 50}`,
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
      const state = manager.registry.get('rutracker').data;
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
        const preLoginRes = await manager.fetchWithOpts('https://rutracker.org/forum/login.php', {
          headers: BROWSER_HEADERS,
          cache: 'no-store'
        });
        if (!preLoginRes.ok) throw new Error(`Failed to GET login page, status=${preLoginRes.status}`);
        const preLoginCookies = getSetCookie(preLoginRes);
        if (!preLoginCookies.length) throw new Error('Did not receive initial session cookie. Anti-bot may be active.');
        const initialCookies = preLoginCookies.map(c => c.split(';')[0]).join('; ');
        const loginBody = 'login_username=Gottesman&login_password=3dmen3d&login=%C2%F5%EE%E4';
        const loginRes = await manager.fetchWithOpts('https://rutracker.org/forum/login.php', {
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
        manager.setScraperData('rutracker', {
          cookies: finalCookies
        });
        console.log('[rutracker] Successfully logged in.');
        return true;
      } catch (err) {
        console.error('[rutracker] Login error:', err.message);
        manager.setScraperData('rutracker', {
          cookies: null
        });
        return false;
      }
    },
  });

  console.log(`[Scrapers] Initialized ${manager.registry.size} scrapers`);
}

module.exports = {
  initializeScrapers
};
