// Minimal torrent search helpers for Electron main process
const cheerio = require('cheerio');

async function fetchText(url, opts) {
  const merged = Object.assign({}, opts || {}, {
    cache: 'force-cache',
    headers: Object.assign({}, opts && opts.headers ? opts.headers : {}, { 'Cache-Control': 'max-age=31536000' })
  });
  const res = await fetch(url, merged);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function searchTPB(query, page = 0) {
  const url = `https://tpb.party/search/${encodeURIComponent(query)}/${page}/99/0`;
  console.log('torrent-search: tpb list URL ->', url);
  const html = await fetchText(url, { headers: { 'User-Agent': 'Freely/1.0' } });
  const $ = cheerio.load(html);
  const out = [];
  const rows = $('#searchResult tr').slice(1);
  rows.each((i, el) => {
    // TPB has list and table layouts. Prefer .detName selector but fall back to the
    // second <td>'s first <a> when dealing with table rows.
    let title = $(el).find('.detName a').text().trim();
    let urlp = $(el).find('.detName a').attr('href');
    if (!title) {
      const td = $(el).find('td').eq(1);
      const a = td.find('a').first();
      title = a.text().trim();
      urlp = urlp || a.attr('href');
    }
    const magnet = $(el).find('a[title="Download this torrent using magnet"]').attr('href');
    const size = $(el).find('td').eq(4).text() || '';
    const seeders = parseInt($(el).find('td').eq(5).text()) || 0;
    const leechers = parseInt($(el).find('td').eq(6).text()) || 0;
    out.push({ title, magnetURI: magnet, size, seeders, leechers, source: 'tpb', url: urlp || undefined });
  });
  return out;
}

async function search1337x(query, page = 1) {
  const url = `https://www.1337x.to/search/${encodeURIComponent(query)}/${page}/`;
  console.log('torrent-search: 1337x list URL ->', url);
  const html = await fetchText(url, { headers: { 'User-Agent': 'Freely/1.0' } });
  const $ = cheerio.load(html);
  const out = [];
  const rows = $('table.table-list tbody tr');
  for (let i = 0; i < rows.length; i++) {
    const el = rows[i];
    const title = $(el).find('td.coll-1 a').text().trim();
    const detailPath = $(el).find('td.coll-1 a').eq(1).attr('href');
    const seeders = parseInt($(el).find('td.coll-2').text()) || 0;
    const leechers = parseInt($(el).find('td.coll-3').text()) || 0;
    const sizeText = $(el).find('td.coll-4').text().trim();
    const urlp = detailPath ? `https://www.1337x.to${detailPath}` : undefined;
    out.push({ title, seeders, leechers, size: sizeText, source: '1337x', url: urlp });
  }
  console.log('torrent-search: 1337x results ->', out);
  // Try to fetch magnet URIs from detail pages in parallel (limited)
  await Promise.all(out.map(async (r) => {
    if (!r.url) return;
    try {
  console.log('torrent-search: 1337x detail URL ->', r.url);
      const dhtml = await fetchText(r.url, { headers: { 'User-Agent': 'Freely/1.0' } });
      const $$ = cheerio.load(dhtml);
      const magnet = $$('.download a').first().attr('href') || $$('.torrent-detail ul li a[href^="magnet:"]').attr('href');
      if (magnet) r.magnetURI = magnet;
    } catch (e) {
      // ignore
    }
  }));
  return out;
}

function listScrapers() {
  return [
    { id: 'tpb', name: 'The Pirate Bay' },
    { id: '1337x', name: '1337x' },
    { id: 'kickass', name: 'Kickass Torrents' },
    { id: 'torrentgalaxy', name: 'Torrent Galaxy' },
    { id: 'magnetdl', name: 'MagnetDL' },
    { id: 'torrent9', name: 'Torrent9' }
  ];
}

async function search(opts) {
  const { query, page = 1 } = opts || {};
  if (!query) return [];
  // Run all scrapers in parallel and merge results
  const tasks = [
    searchTPB(query, 0),
    search1337x(query, page),
    searchKickass(query, page),
    searchTorrentGalaxy(query, page),
    searchMagnetDL(query, page)
  ].map(p => Promise.resolve(p).catch(e => { return []; }));
  const results = await Promise.all(tasks);
  const flat = results.flat();
  // Filter results: title must contain at least one word from the query (ignore non-letters)
  const q = String(query || '').toLowerCase();
  const qWords = q.replace(/[^a-z]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let filtered = flat;
  if (qWords.length) {
    filtered = flat.filter(r => {
      if (!r || !r.title) return false;
      const title = String(r.title).toLowerCase().replace(/[^a-z]+/g, ' ');
      return qWords.some(w => title.includes(w));
    });
  }
  return filtered.sort((x, y) => (y.seeders || 0) - (x.seeders || 0));
}

// --- Additional scrapers ---
async function searchKickass(query, page = 0) {
  try {
  const url = `https://kickasstorrents.cc/search.php?q=${encodeURIComponent(query)}&field=seeders&sorder=desc&page=${page}`;
  console.log('torrent-search: kickass list URL ->', url);
    const html = await fetchText(url, { headers: { 'User-Agent': 'Freely/1.0' } });
    const $ = cheerio.load(html);
    const out = [];
    $('table.data tr.even').each((i, tr) => {
      try {
        const $a = $(tr).find('a');
        const title = ($a.attr('title') || $a.text() || $a.parent().text() || '').trim();
        const href = $a.attr('href') && !$a.attr('href').startsWith('magnet:') ? $a.attr('href') : undefined;
        const seeders = parseInt($(tr).find('td.green').text()) || 0;
        const leechers = parseInt($(tr).find('td.red').text()) || 0;
        const size = ($(tr).find('td').filter((i, el) => /MiB|GiB|KB|MB/i.test($(el).text())).first().text() || '').trim() || undefined;
        out.push({ title, size, seeders, leechers, source: 'kickass', url: href });
      } catch (e) {}
    });
    return out.filter(r => r.title || r.magnetURI);
  } catch (e) { return []; }
}

async function searchTorrentGalaxy(query, page = 1) {
  try {
  const url = `https://torrentgalaxy.hair/lmsearch?q=${encodeURIComponent(query)}&page=${page}&category=lmsearch`;
  console.log('torrent-search: torrentgalaxy list URL ->', url);
    const html = await fetchText(url, { headers: { 'User-Agent': 'Freely/1.0' } });
    const $ = cheerio.load(html);
    const out = [];
    // magnets
    $('tbody.torsearch tr').each((i, tr) => {
      const $a = $(tr).find('td.tdleft a');
      const title = ($a.attr('id-text') || $a.text() || '').trim();
      const href = $a.attr('href');
      const seeders = parseInt($(tr).find('td.tdleech').text()) || 0;
      const leechers = parseInt($(tr).find('td.tdseed').text()) || 0;
      const size = ($(tr).find('td.tdnormal').filter((i, el) => /GB|KB|MB/i.test($(el).text())).first().text() || '').trim() || undefined;
      if (title) out.push({ title, source: 'torrentgalaxy', url: href ? href : undefined, seeders, leechers, size });
    });
    // Try to fetch magnet URIs from detail pages
    await Promise.all(out.map(async r => {
      if (!r.url) return;
      try {
        const detailUrl = /^https?:\/\//i.test(r.url) ? r.url : `https://torrentgalaxy.hair${r.url.startsWith('/') ? r.url : '/' + r.url}`;
        console.log('torrent-search: torrentgalaxy detail URL ->', detailUrl);
        const dhtml = await fetchText(detailUrl, { headers: { 'User-Agent': 'Freely/1.0' } });
        const $$ = cheerio.load(dhtml);
        const magnet = $$('ul.download-links-dontblock a[href^="magnet:"]').first().attr('href');
        if (magnet) r.magnetURI = magnet;
      } catch (e) { /* ignore */ }
    }));
    return out;
  } catch (e) { return []; }
}

async function searchMagnetDL(query, page = 1) {
  try {
  const url = `https://magnetdl.app/search/?q=${encodeURIComponent(query)}&m=${page}`;
  console.log('torrent-search: magnetdl list URL ->', url);
    const html = await fetchText(url, { headers: { 'User-Agent': 'Freely/1.0' } });
    const $ = cheerio.load(html);
    const out = [];
    $('tbody.torsearch tr').each((i, tr) => {
      const $tr = $(tr);
      const title = ($tr.find('td').eq(1).text() || '').trim();
      const url = $tr.find('td.m a').attr('href');
      const seeders = parseInt($tr.find('td.s').text()) || 0;
      const leechers = parseInt($tr.find('td.l').text()) || 0;
      const size = ($tr.find('td').eq(4).filter((i, el) => /GB|KB|MB/i.test($(el).text())).first().text() || '').trim() || undefined;
      out.push({ title, url, source: 'magnetdl', seeders, leechers, size });
    });

    // Try to fetch magnet URIs from detail pages on magnetdl.app
    await Promise.all(out.map(async r => {
      if (!r.url) return;
      try {
        let detailUrl = r.url;
        if (!/^https?:\/\//i.test(detailUrl)) {
          if (detailUrl.startsWith('/')) detailUrl = `https://magnetdl.app${detailUrl}`;
          else detailUrl = `https://magnetdl.app/${detailUrl}`;
        }
        console.log('torrent-search: magnetdl detail URL ->', detailUrl);
        const dhtml = await fetchText(detailUrl, { headers: { 'User-Agent': 'Freely/1.0' } });
        const $$ = cheerio.load(dhtml);
        const anchor = $$('.fill-content').first().find('.col1').find('a').first();
        const magnet = anchor.attr('href');
        if (magnet) r.magnetURI = magnet;
      } catch (e) { /* ignore */ }
    }));
    return out;
  } catch (e) { return []; }
}

async function searchTorrent9(query, page = 1) {
  try {
  const url = `https://torrent9.to/search_torrent/musique/${encodeURIComponent(query.replace(/\s/g, '-'))}.html`;
  console.log('torrent-search: torrent9 list URL ->', url);
    const html = await fetchText(url, { headers: { 'User-Agent': 'Freely/1.0' } });
    const $ = cheerio.load(html);
    const out = [];
    $("table.table-striped tbody tr").each((i, tr) => {
      const $tr = $(tr);
      const title = ($tr.find('td').eq(0).text() || '').trim();
      const url = $tr.find('td').eq(0).find('a').attr('href');
      const seeders = parseInt($tr.find('span.seed_ok').text()) || 0;
      const leechers = parseInt($tr.find('td').last().text()) || 0;
      const size = ($tr.find('td').eq(2).filter((i, el) => /Go|Ko|Mo/i.test($(el).text())).first().text().replace(/Go|Ko|Mo/i, (match) => {
        switch (match) {
          case 'Go': return 'GB';
          case 'Ko': return 'KB';
          case 'Mo': return 'MB';
        }
      }) || '').trim() || undefined;
      out.push({ title, url, source: 'torrent9', seeders, leechers, size });
    });
    // Try to fetch magnet URIs from detail pages for torrent9
    const promises = out.map(async r => {
      if (!r.url) return r;
      try {
        const detailUrl = r.url.startsWith('http') ? r.url : `https://torrent9.to${r.url}`;
        console.log('torrent-search: torrent9 detail URL ->', detailUrl);
        const dhtml = await fetchText(detailUrl, { headers: { 'User-Agent': 'Freely/1.0' } });
        const $$ = cheerio.load(dhtml);
        const magnet = $$('.download-btn a[href^="magnet:"]').first().attr('href');
        if (magnet) r.magnetURI = magnet;
      } catch (e) { /* ignore */ }
      return r;
    });
    return Promise.all(promises);
  } catch (e) { return []; }
}

module.exports = { listScrapers, search };
